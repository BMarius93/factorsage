"use client";

import {
  BACKTEST_RUN_STATUS_LABELS,
  isTerminalBacktestStatus,
  type BacktestRunStatus,
  type BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { PageContainer } from "../../../components/layout/PageContainer";
import {
  DataTable,
  IntermediateOnly,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { CollectionFooter } from "../../../components/ui/CollectionFooter";
import { usePagination } from "../../../components/ui/use-pagination";
import actionStyles from "../../../components/ui/actions.module.css";
import { SkeletonList } from "../../../components/ui/Skeleton";
import {
  StatusBadge,
  type StatusTone,
} from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useBacktestRuns } from "../hooks/use-backtest-runs";
import {
  formatPeriod,
  formatSignedPercent,
  formatTimestamp,
  METRIC_PLACEHOLDER,
} from "../utils/format";
import styles from "./BacktestsPage.module.css";

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

/** A return, tinted by direction. Zero and "not reported" stay neutral. */
function ReturnValue({ value }: { readonly value: number | null }) {
  if (value === null) {
    return <span className={styles.placeholder}>{METRIC_PLACEHOLDER}</span>;
  }
  return (
    <span
      className={styles.figure}
      data-tone={value === 0 ? undefined : value > 0 ? "positive" : "negative"}
    >
      {formatSignedPercent(value)}
    </span>
  );
}

/**
 * The signed-in user's backtest runs.
 *
 * A run's own page owns live progress; this collection reports the state each run was in when the
 * list was fetched, so opening the app does not start a poll per row.
 */
/** The benchmark and what it returned over the same period: one fact, in one place. */
function BenchmarkFact({ run }: { readonly run: BacktestRunSummaryResponse }) {
  return (
    <span className={styles.benchmarkCell}>
      <EntityReferenceChip kind="benchmark" name={run.benchmarkName} />
      {run.benchmarkReturnPercent === null ? (
        <span className={styles.placeholder}>{METRIC_PLACEHOLDER}</span>
      ) : (
        <span className={styles.benchmarkReturn}>
          {formatSignedPercent(run.benchmarkReturnPercent)}
        </span>
      )}
    </span>
  );
}

export function BacktestsPage() {
  const { status, runs, retry } = useBacktestRuns();

  const columns: readonly DataTableColumn<BacktestRunSummaryResponse>[] = [
    {
      key: "run",
      header: "Strategy",
      cardRole: "identity",
      render: (run) => (
        <Link className={styles.nameLink} href={`/backtests/${run.id}`}>
          <span className={styles.name}>{run.strategyName}</span>
          <span className={styles.period}>
            {formatPeriod(run.startDate, run.endDate)}
          </span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cardRole: "status",
      render: (run) => {
        // Both terminal statuses are finished. A FAILED run rendered through the in-flight
        // branch would show a filled progress bar under a "Failed" pill.
        const finished = isTerminalBacktestStatus(run.status);
        return (
          <span className={styles.statusCell}>
            <StatusBadge
              tone={statusTone(run.status)}
              testId="backtest-card-status"
              // The raw status alongside the label: a test reading "Preparing data" would be
              // asserting on prose, and the prose is allowed to change.
              dataAttributes={{ "data-status": run.status }}
            >
              {BACKTEST_RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
            {finished ? null : (
              // A queued or executing run has no result to report; what it does have is how
              // far along it is, which is the only honest thing a collection row can show.
              <span className={styles.progress}>
                <span className={styles.track} aria-hidden="true">
                  <span
                    className={styles.fill}
                    style={{
                      width: `${Math.min(100, Math.max(0, run.progressPercent))}%`,
                    }}
                  />
                </span>
                <span className={styles.progressText}>
                  {run.progressMessage ??
                    `${Math.round(run.progressPercent)}% complete`}
                </span>
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "list",
      header: "Stock list",
      cardRole: "links",
      // Linked while the list still exists; a list deleted since the run keeps its snapshotted
      // name as a static chip rather than a link that would 404 (UI-034).
      render: (run) => (
        <span className={styles.listCell}>
          <EntityReferenceChip
            kind="list"
            name={run.stockListName}
            {...(run.stockListId ? { href: `/lists/${run.stockListId}` } : {})}
          />
          {/* The Benchmark column folds in here between 880 and 1,279px. */}
          <IntermediateOnly testId="backtest-folded-benchmark">
            <BenchmarkFact run={run} />
          </IntermediateOnly>
        </span>
      ),
    },
    {
      key: "benchmark",
      header: "Benchmark",
      cardRole: "links",
      foldIntermediate: true,
      // The benchmark and what it returned over the same period are one fact, so they
      // share a cell rather than sitting in two columns with a stock list between them.
      render: (run) => <BenchmarkFact run={run} />,
    },
    {
      key: "portfolio",
      header: "Portfolio",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (run) => <ReturnValue value={run.portfolioReturnPercent} />,
    },
    {
      key: "alpha",
      // Excess return over the benchmark, not a regression alpha — see `BacktestMetricsRow`.
      header: "Excess return",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (run) => <ReturnValue value={run.alphaPercent} />,
    },
    {
      key: "queued",
      header: "Queued",
      cardRole: "hidden",
      // Low-priority: the one column that steps out in the intermediate band without a folded
      // copy — the run's own page carries its timestamps.
      foldIntermediate: true,
      nowrap: true,
      render: (run) => formatTimestamp(run.queuedAt),
    },
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      // A run has no maintenance actions — there is no rename and no delete in the
      // contract — so the column carries only the contextual one. A run still executing
      // opens the same page, where its progress is live (UI-034).
      render: (run) => {
        const label = isTerminalBacktestStatus(run.status)
          ? "View results"
          : "View progress";
        return (
          <Link
            className={actionStyles.action}
            href={`/backtests/${run.id}`}
            aria-label={`${label} for ${run.strategyName}`}
          >
            {label}
          </Link>
        );
      },
    },
  ];
  const paging = usePagination(runs);

  return (
    <PageContainer>
      <div className={styles.page} data-testid="backtests-page">
        <PageHeader
          title="Backtests"
          lead="Run a strategy over a stock list and a historical period, and compare it against a benchmark."
          actions={
            status === "ready" && runs.length > 0 ? (
              <Link
                className={forms.tintedButton}
                href="/backtests/new"
                data-testid="new-backtest-button"
              >
                New backtest
              </Link>
            ) : null
          }
        />

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading backtests">
            <SkeletonList rows={4} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="Your backtests could not be loaded"
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
        ) : null}

        {status === "ready" && runs.length === 0 ? (
          <EmptyState
            testId="backtests-empty"
            title="No backtests yet"
            body={
              <p>
                A backtest executes one strategy over one stock list across a
                historical period, with your capital, contributions and position
                limit. Results appear while it runs.
              </p>
            }
            actions={
              <Link
                className={forms.primaryButton}
                href="/backtests/new"
                data-testid="new-backtest-button"
              >
                Run your first backtest
              </Link>
            }
          />
        ) : null}

        {status === "ready" && runs.length > 0 ? (
          <SectionCard ariaLabel="Backtest runs" flush>
            <DataTable
              label="Backtest runs"
              testId="backtests-grid"
              rowTestId="backtest-card"
              columns={columns}
              rows={paging.visibleRows}
              getRowKey={(run) => run.id}
              clickableRows
            />
            <CollectionFooter
              testId="backtests-footer"
              noun="runs"
              total={paging.total}
              page={paging.page}
              pageSize={paging.pageSize}
              onPageChange={paging.setPage}
              onPageSizeChange={paging.setPageSize}
            />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
