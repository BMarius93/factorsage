"use client";

import {
  BACKTEST_RUN_STATUS_LABELS,
  backtestRunLabel,
  isTerminalBacktestStatus,
  type BacktestRunSort,
  type BacktestRunStatus,
  type BacktestRunStatusFilter,
  type BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import {
  DataTable,
  IntermediateOnly,
  type DataTableColumn,
  type DataTableSort,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import {
  CollectionFooter,
  formatCount,
} from "../../../components/ui/CollectionFooter";
import {
  COLLECTION_SEARCH_THRESHOLD,
  CollectionSearchField,
  CollectionToolbar,
  VisuallyHidden,
} from "../../../components/ui/Collection";
import actionStyles from "../../../components/ui/actions.module.css";
import {
  SelectControl,
  type SelectControlOption,
} from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import {
  StatusBadge,
  type StatusTone,
} from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useBacktestRunPage } from "../hooks/use-backtest-run-page";
import {
  formatPeriod,
  formatSignedPercent,
  formatSignedPoints,
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

/**
 * A return, tinted by direction. Zero and "not reported" stay neutral. `format` decides the unit:
 * a return is a percentage, a difference between two returns is in percentage points.
 */
function ReturnValue({
  value,
  format = formatSignedPercent,
}: {
  readonly value: number | null;
  readonly format?: (value: number) => string;
}) {
  if (value === null) {
    return <span className={styles.placeholder}>{METRIC_PLACEHOLDER}</span>;
  }
  return (
    <span
      className={styles.figure}
      data-tone={value === 0 ? undefined : value > 0 ? "positive" : "negative"}
    >
      {format(value)}
    </span>
  );
}

/**
 * The strategy the run executed, by the name it was submitted with — never the strategy's current
 * name — and linked while that strategy still exists. A strategy deleted since the run keeps its
 * name as a static chip rather than a link that would 404 (UI-034).
 */
function StrategyReference({
  run,
}: {
  readonly run: BacktestRunSummaryResponse;
}) {
  return (
    <EntityReferenceChip
      kind="strategy"
      name={run.strategyName}
      testId="backtest-strategy-reference"
      {...(run.strategyId ? { href: `/strategies/${run.strategyId}` } : {})}
    />
  );
}

/**
 * The run's stock list, by the name it was submitted with, linked while the list still exists; a
 * list deleted since the run keeps its name as a static chip rather than a link that would 404
 * (UI-034).
 */
function StockListReference({
  run,
}: {
  readonly run: BacktestRunSummaryResponse;
}) {
  return (
    <EntityReferenceChip
      kind="list"
      name={run.stockListName}
      testId="backtest-list-reference"
      {...(run.stockListId ? { href: `/lists/${run.stockListId}` } : {})}
    />
  );
}

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

/** The orders the history can be read in, as the Sort control offers them. */
const RUN_SORT_OPTIONS: readonly SelectControlOption[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  // By the stored annualized return, never the cumulative one (BT-3): a thirty-year run's total
  // return dwarfs a five-year run's whatever their quality, so "best return" ranked by length.
  { value: "cagr", label: "Best CAGR" },
  { value: "strategy", label: "Strategy A–Z" },
];

const ALL_STATUSES = "all";

const RUN_STATUS_OPTIONS: readonly SelectControlOption[] = [
  { value: ALL_STATUSES, label: "All statuses" },
  { value: "ACTIVE", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "FAILED", label: "Failed" },
];

/** The column a sort is the order of, for the header that shows it. */
const SORT_COLUMNS: Readonly<Record<BacktestRunSort, DataTableSort>> = {
  newest: { key: "created", direction: "desc" },
  oldest: { key: "created", direction: "asc" },
  cagr: { key: "cagr", direction: "desc" },
  strategy: { key: "strategy", direction: "asc" },
};

/** The sort a pressed header asks for; Created toggles between its two directions. */
function sortForColumn(
  column: string,
  current: BacktestRunSort,
): BacktestRunSort | null {
  switch (column) {
    case "strategy":
      return "strategy";
    case "cagr":
      return "cagr";
    case "created":
      return current === "newest" ? "oldest" : "newest";
    default:
      return null;
  }
}

/** How long typing pauses before the search is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The search field's own text, sent once typing pauses. The address bar holds what was sent; a
 * Back or Forward that changes it brings the field along.
 */
function useSearchDraft(
  committed: string | null,
  commit: (q: string | null) => void,
) {
  const [draft, setDraft] = useState(committed ?? "");
  const lastCommitted = useRef(committed ?? "");
  useEffect(() => {
    lastCommitted.current = committed ?? "";
    setDraft(committed ?? "");
  }, [committed]);
  useEffect(() => {
    if (draft.trim() === lastCommitted.current) {
      return;
    }
    const timer = setTimeout(() => commit(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, commit]);
  return [draft, setDraft] as const;
}

/**
 * The signed-in user's backtest runs, a page at a time.
 *
 * A run is identified by its own Run ID — `Run #0001`, sequential per user and never changed — not
 * by the strategy it executed: several runs of one strategy are different runs, and the strategy is
 * one of their inputs, with a column of its own beside the stock list.
 *
 * Paged, searched, filtered and ordered by the API (`GET /backtests?page=`), with the whole view in
 * the URL — so every count and every page describe the whole history, the browser never holds more
 * than the page on screen, and no run's snapshot is read to list it. A run's own page owns live
 * progress; this page re-reads only itself, and only while it shows a run still in flight.
 *
 * Compact, like Lists, Strategies and Monitors: the title, the count and the controls on one row;
 * the row opens through its Run ID, so there is no second "View results" link in it.
 */
export function BacktestsPage() {
  const runs = useBacktestRunPage();
  const { result, view } = runs;
  const [draft, setDraft] = useSearchDraft(view.q, runs.setQuery);

  const columns: readonly DataTableColumn<BacktestRunSummaryResponse>[] = [
    {
      key: "run",
      header: "Run",
      cardRole: "identity",
      // The Run ID and the period are short and never wrap, so the identity needs less than the
      // default floor a name would; the relationship chips beside it get the difference.
      minWidth: "10.5rem",
      render: (run) => (
        <>
          <Link className={styles.nameLink} href={`/backtests/${run.id}`}>
            <span className={styles.name} data-testid="backtest-run-label">
              {backtestRunLabel(run.runNumber)}
            </span>
            <span className={styles.period}>
              {formatPeriod(run.startDate, run.endDate)}
            </span>
          </Link>
          {/* Between 880 and 1,279px the Strategy and Stock list columns fold in here, under the
              period, as on Monitors: with the CAGR column the run's figures need the room. */}
          <IntermediateOnly testId="backtest-folded-references">
            <span className={styles.foldedReferences}>
              <StrategyReference run={run} />
              <StockListReference run={run} />
            </span>
          </IntermediateOnly>
        </>
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
              size="small"
              // A small pulse on a job that is still processing, and nothing more: this is a
              // collection, so "alive" is all a row needs to say. The row itself never animates.
              pulse={!finished}
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
      key: "strategy",
      header: "Strategy",
      cardRole: "links",
      foldIntermediate: true,
      sortable: true,
      width: "13%",
      render: (run) => (
        <span className={styles.referenceCell}>
          <StrategyReference run={run} />
        </span>
      ),
    },
    {
      key: "list",
      header: "Stock list",
      cardRole: "links",
      foldIntermediate: true,
      width: "13%",
      render: (run) => (
        <span className={styles.referenceCell}>
          <StockListReference run={run} />
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
      // The annualized return: the one figure that compares runs of different lengths (BT-3).
      key: "cagr",
      header: "CAGR",
      align: "right",
      numeric: true,
      nowrap: true,
      sortable: true,
      render: (run) => <ReturnValue value={run.portfolioCagrPercent} />,
    },
    {
      key: "portfolio",
      header: "Total return",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (run) => (
        <span className={styles.returnCell}>
          <ReturnValue value={run.portfolioReturnPercent} />
          {/* Between 880 and 1,279px the Benchmark column folds in here, as the comparison it
              is — never under the stock list, where it read as part of the list (BT-3). */}
          <IntermediateOnly testId="backtest-folded-benchmark">
            <span className={styles.foldedBenchmark}>
              vs {run.benchmarkName}{" "}
              {run.benchmarkReturnPercent === null
                ? METRIC_PLACEHOLDER
                : formatSignedPercent(run.benchmarkReturnPercent)}
            </span>
          </IntermediateOnly>
        </span>
      ),
    },
    {
      key: "alpha",
      // Excess return over the benchmark, not a regression alpha — see `BacktestMetricsRow`. A
      // difference between two returns, so it is written in percentage points.
      header: "Excess return",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (run) => (
        <ReturnValue value={run.alphaPercent} format={formatSignedPoints} />
      ),
    },
    {
      // When the run was submitted. Not "Queued": a run is created and queued in one step, and
      // the time it then waited in the queue is not what this column reports.
      key: "created",
      header: "Created",
      cardRole: "hidden",
      // Low-priority: the one column that steps out in the intermediate band without a folded
      // copy — the run's own page carries its timestamps.
      foldIntermediate: true,
      nowrap: true,
      sortable: true,
      render: (run) => formatTimestamp(run.queuedAt),
    },
  ];

  const total = result?.unfilteredCount ?? 0;
  const filtered = view.q !== null || view.status !== null;
  const searchable = total >= COLLECTION_SEARCH_THRESHOLD || view.q !== null;
  const controls = total > 1 || filtered;
  const showTable = result !== null && result.totalCount > 0;

  const toolbar =
    result !== null && controls ? (
      <CollectionToolbar density="compact" testId="backtests-toolbar">
        {searchable ? (
          <CollectionSearchField
            noun="runs"
            value={draft}
            onChange={setDraft}
            testId="backtests-search"
          />
        ) : null}
        <SelectControl
          id="backtests-status"
          label="Status"
          value={view.status ?? ALL_STATUSES}
          onChange={(value) =>
            runs.setStatus(
              value === ALL_STATUSES
                ? null
                : (value as BacktestRunStatusFilter),
            )
          }
          options={RUN_STATUS_OPTIONS}
          testId="backtests-status"
        />
        <SelectControl
          id="backtests-sort"
          label="Sort"
          value={view.sort}
          onChange={(value) => runs.setSort(value as BacktestRunSort)}
          options={RUN_SORT_OPTIONS}
          testId="backtests-sort"
        />
        {/* What a search or a filter left, said once for assistive technology. */}
        <VisuallyHidden role="status">
          {filtered
            ? `${formatCount(result.totalCount)} of ${formatCount(total)} runs match.`
            : ""}
        </VisuallyHidden>
      </CollectionToolbar>
    ) : null;

  const count =
    result !== null && total > 0 ? (
      <span data-testid="backtests-count">
        {filtered
          ? `${formatCount(result.totalCount)} of ${formatCount(total)}`
          : formatCount(total)}
        <VisuallyHidden> runs</VisuallyHidden>
      </span>
    ) : undefined;

  return (
    <PageContainer>
      <div className={styles.page} data-testid="backtests-page">
        <PageHeader
          variant="plain"
          title="Backtests"
          lead="Run a strategy over a stock list and a historical period, and compare it against a benchmark."
          // In the header in every state, never swapped for an empty state's own button (UI-030).
          actions={
            <Link
              className={forms.tintedButton}
              href="/backtests/new"
              data-testid="new-backtest-button"
            >
              New backtest
            </Link>
          }
        />

        {runs.status === "loading" ? (
          <SectionCard
            density="compact"
            title="Your backtests"
            ariaLabel="Loading backtests"
          >
            <SkeletonList rows={4} />
          </SectionCard>
        ) : null}

        {runs.status === "error" ? (
          <EmptyState
            variant="error"
            title="Your backtests could not be loaded"
            body={<p>This is usually temporary — try again in a moment.</p>}
            actions={
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={runs.retry}
              >
                Try again
              </button>
            }
          />
        ) : null}

        {runs.status === "ready" && result !== null ? (
          // One composition for every collection (UI-012): a titled section whose empty state is
          // the compact one, exactly like Lists, Strategies and Monitors.
          <SectionCard
            density="compact"
            title="Your backtests"
            ariaLabel="Backtest runs"
            testId="your-backtests"
            flush={showTable}
            {...(count === undefined ? {} : { count })}
            {...(toolbar === null ? {} : { toolbar })}
          >
            {runs.failed ? (
              <p
                className={styles.readFailed}
                role="alert"
                data-testid="backtests-read-failed"
              >
                These runs could not be loaded.{" "}
                <button
                  type="button"
                  className={actionStyles.action}
                  onClick={runs.retry}
                >
                  Try again
                </button>
              </p>
            ) : null}
            {total === 0 ? (
              <EmptyState
                variant="compact"
                testId="backtests-empty"
                title="No backtests yet"
                body={
                  <p>
                    A backtest executes one strategy over one stock list across
                    a historical period, with your capital, contributions and
                    position limit. Results appear while it runs. Start with{" "}
                    <strong>New backtest</strong> above.
                  </p>
                }
              />
            ) : null}
            {total > 0 && result.totalCount === 0 ? (
              // Filtered to nothing is not "empty": the runs exist, and the way back is one press.
              <EmptyState
                variant="compact"
                testId="backtests-filtered-empty"
                title={
                  view.q === null
                    ? "No runs match this filter"
                    : `No runs match “${view.q}”`
                }
                actions={
                  <button
                    type="button"
                    className={forms.secondaryButton}
                    onClick={() => {
                      setDraft("");
                      runs.clearFilters();
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : null}
            {showTable ? (
              <>
                <DataTable
                  density="compact"
                  label="Backtest runs"
                  testId="backtests-grid"
                  rowTestId="backtest-card"
                  columns={columns}
                  rows={result.runs}
                  getRowKey={(run) => run.id}
                  sort={SORT_COLUMNS[view.sort]}
                  onSortChange={(column) => {
                    const next = sortForColumn(column, view.sort);
                    if (next !== null) {
                      runs.setSort(next);
                    }
                  }}
                  clickableRows
                />
                <CollectionFooter
                  density="compact"
                  testId="backtests-footer"
                  noun="runs"
                  total={result.totalCount}
                  page={result.page}
                  pageSize={result.pageSize}
                  busy={runs.loading}
                  onPageChange={runs.setPage}
                  onPageSizeChange={runs.setPageSize}
                />
              </>
            ) : null}
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}
