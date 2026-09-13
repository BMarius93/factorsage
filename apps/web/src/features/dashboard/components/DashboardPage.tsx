"use client";

import {
  BACKTEST_RUN_STATUS_LABELS,
  type BacktestRunSummaryResponse,
  type MonitorSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { stockCountLabel } from "../../lists/utils/format";
import { lastScanLabel } from "../../monitors/utils/format";
import { formatTimestamp } from "../../backtests/utils/format";
import { useDashboard } from "../hooks/use-dashboard";
import { SummaryStrip, type SummaryTile } from "./SummaryStrip";
import styles from "./DashboardPage.module.css";

/** How many recent runs the home page lists before sending the user to the full history. */
const RECENT_RUN_LIMIT = 5;

type WatchFilter = "all" | "matching" | "attention";

const WATCH_FILTERS: readonly {
  readonly id: WatchFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "matching", label: "With signals" },
  { id: "attention", label: "Needs attention" },
];

/**
 * A monitor needs attention when the user asked for it to run and the system is not running it —
 * either an entitlement is holding it back, or it is switched off. Both are states the user can
 * act on, and neither is a match.
 */
function needsAttention(monitor: MonitorSummaryResponse): boolean {
  return (
    monitor.operationalStatus === "BLOCKED_BY_ENTITLEMENT" || !monitor.enabled
  );
}

function matchesFilter(
  monitor: MonitorSummaryResponse,
  filter: WatchFilter,
): boolean {
  if (filter === "matching") {
    return monitor.activeSignalCount > 0;
  }
  if (filter === "attention") {
    return needsAttention(monitor);
  }
  return true;
}

/**
 * The application home.
 *
 * The legacy dashboard led with a "Real-time Matches" table: every stock currently matching, across
 * every monitor, with its monitor, strategy and list beside it. V2 cannot answer that in one
 * request — `GET /monitors` carries per-monitor counts, and only `GET /monitors/{id}` carries the
 * evaluated securities — so this page reports what is true at the collection level and links into
 * each monitor for the stocks behind the count. It never fans out a request per monitor to
 * reconstruct the missing aggregate, and it never invents a match. See `ai/architecture/frontend.md`
 * for the read model this is waiting on.
 */
export function DashboardPage() {
  const { status, monitors, runs, retry } = useDashboard();
  const [filter, setFilter] = useState<WatchFilter>("all");

  const activeSignals = monitors.reduce(
    (total, monitor) => total + monitor.activeSignalCount,
    0,
  );
  const scanning = monitors.filter(
    (monitor) =>
      monitor.enabled && monitor.operationalStatus !== "BLOCKED_BY_ENTITLEMENT",
  ).length;
  const attention = monitors.filter(needsAttention).length;
  const latestRun = runs[0];

  const summaryTiles: readonly SummaryTile[] = [
    {
      id: "run-backtest",
      label: "Backtest",
      value: "Run a backtest",
      detail: "Test a strategy over history",
      href: "/backtests/new",
      tone: "action",
    },
    {
      id: "signals",
      label: "Active signals",
      value: activeSignals,
      detail:
        activeSignals === 0
          ? "Nothing is matching right now"
          : "Across all your monitors",
      href: "/monitors",
    },
    {
      id: "scanning",
      label: "Scanning",
      value: `${scanning}/${monitors.length}`,
      detail:
        attention === 0
          ? "All monitors are running"
          : `${attention} ${
              attention === 1 ? "monitor needs" : "monitors need"
            } attention`,
      href: "/monitors",
    },
    {
      id: "latest-run",
      label: "Latest backtest",
      value: latestRun
        ? BACKTEST_RUN_STATUS_LABELS[latestRun.status]
        : "None yet",
      ...(latestRun
        ? {
            detail: latestRun.strategyName,
            href: `/backtests/${latestRun.id}`,
          }
        : { detail: "You have not run one yet", href: "/backtests/new" }),
    },
  ];

  const visibleMonitors = monitors
    .filter((monitor) => matchesFilter(monitor, filter))
    // Whatever has something to look at comes first; the rest keep the API's order.
    .slice()
    .sort((left, right) => right.activeSignalCount - left.activeSignalCount);

  const monitorColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    {
      key: "monitor",
      header: "Monitor",
      cardRole: "identity",
      render: (monitor) => (
        <Link className={styles.nameLink} href={`/monitors/${monitor.id}`}>
          {monitor.name}
        </Link>
      ),
    },
    {
      key: "signals",
      header: "Active signals",
      cardRole: "status",
      nowrap: true,
      render: (monitor) =>
        monitor.activeSignalCount > 0 ? (
          <StatusBadge tone="active">
            {monitor.activeSignalCount}{" "}
            {monitor.activeSignalCount === 1 ? "signal" : "signals"}
          </StatusBadge>
        ) : monitor.operationalStatus === "BLOCKED_BY_ENTITLEMENT" ? (
          <StatusBadge tone="blocked">Not scanning</StatusBadge>
        ) : monitor.enabled ? (
          <StatusBadge tone="neutral">No signals</StatusBadge>
        ) : (
          <StatusBadge tone="pending">Disabled</StatusBadge>
        ),
    },
    {
      key: "strategy",
      header: "Strategy",
      cardRole: "links",
      render: (monitor) => (
        <EntityReferenceChip
          kind="strategy"
          name={monitor.strategyName}
          href={`/strategies/${monitor.strategyId}`}
        />
      ),
    },
    {
      key: "list",
      header: "Stock list",
      cardRole: "links",
      // The universe size rides with the list reference it belongs to, rather than taking
      // a column of its own.
      render: (monitor) => (
        <span className={styles.listCell}>
          <EntityReferenceChip
            kind="list"
            name={monitor.stockListName}
            href={`/lists/${monitor.stockListId}`}
          />
          <span className={styles.listCount}>
            {stockCountLabel(monitor.securityCount)}
          </span>
        </span>
      ),
    },
    {
      key: "checked",
      header: "Last checked",
      nowrap: true,
      render: (monitor) => lastScanLabel(monitor.lastScanAt),
    },
  ];

  const runColumns: readonly DataTableColumn<BacktestRunSummaryResponse>[] = [
    {
      key: "run",
      header: "Strategy",
      cardRole: "identity",
      render: (run) => (
        <Link className={styles.nameLink} href={`/backtests/${run.id}`}>
          {run.strategyName}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cardRole: "status",
      nowrap: true,
      render: (run) => (
        <StatusBadge
          tone={
            run.status === "COMPLETED"
              ? "positive"
              : run.status === "FAILED"
                ? "negative"
                : run.status === "RUNNING" || run.status === "FINALIZING"
                  ? "active"
                  : "pending"
          }
        >
          {BACKTEST_RUN_STATUS_LABELS[run.status]}
        </StatusBadge>
      ),
    },
    {
      key: "list",
      header: "Stock list",
      cardRole: "links",
      render: (run) => (
        <EntityReferenceChip kind="list" name={run.stockListName} />
      ),
    },
    {
      key: "queued",
      header: "Queued",
      nowrap: true,
      render: (run) => formatTimestamp(run.queuedAt),
    },
  ];

  return (
    <PageContainer>
      <div className={styles.page} data-testid="dashboard-page">
        <PageHeader
          title="Dashboard"
          lead="What your monitors are seeing right now, and the backtests you have run."
        />

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading dashboard">
            <SkeletonList rows={5} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="Your dashboard could not be loaded"
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

        {status === "ready" ? (
          <>
            <SummaryStrip tiles={summaryTiles} />

            <SectionCard
              id="watchlist"
              title="Monitors"
              caption="Each monitor evaluates its strategy against current data. Open one to see which stocks are matching and why."
              toolbar={
                monitors.length > 0 ? (
                  <div
                    className={styles.filters}
                    role="group"
                    aria-label="Filter monitors"
                  >
                    {WATCH_FILTERS.map((option) => {
                      const count = monitors.filter((monitor) =>
                        matchesFilter(monitor, option.id),
                      ).length;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={styles.filter}
                          data-active={filter === option.id ? "true" : undefined}
                          aria-pressed={filter === option.id}
                          onClick={() => setFilter(option.id)}
                        >
                          {option.label}
                          <span className={styles.filterCount}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null
              }
              flush={visibleMonitors.length > 0}
            >
              <DataTable
                label="Monitors"
                testId="dashboard-monitors"
                rowTestId="dashboard-monitor-row"
                columns={monitorColumns}
                rows={visibleMonitors}
                getRowKey={(monitor) => monitor.id}
                clickableRows
                emptyState={
                  monitors.length === 0 ? (
                    <EmptyState
                      variant="compact"
                      testId="dashboard-monitors-empty"
                      title="No monitors yet"
                      body={
                        <p>
                          A monitor watches one strategy over one stock list
                          using current prices, and records a signal whenever a
                          stock matches.
                        </p>
                      }
                      actions={
                        <Link className={forms.primaryButton} href="/monitors">
                          Create a monitor
                        </Link>
                      }
                    />
                  ) : (
                    <EmptyState
                      variant="compact"
                      testId="dashboard-monitors-filtered-empty"
                      title="Nothing under this filter"
                      body={
                        <p>
                          No monitor matches the filter you selected right now.
                        </p>
                      }
                    />
                  )
                }
              />
            </SectionCard>

            <SectionCard
              id="recent-backtests"
              title="Recent backtests"
              aside={
                runs.length > RECENT_RUN_LIMIT ? (
                  <Link className={styles.moreLink} href="/backtests">
                    View all {runs.length}
                  </Link>
                ) : null
              }
              flush={runs.length > 0}
            >
              <DataTable
                label="Recent backtests"
                testId="dashboard-backtests"
                rowTestId="dashboard-backtest-row"
                columns={runColumns}
                rows={runs.slice(0, RECENT_RUN_LIMIT)}
                getRowKey={(run) => run.id}
                clickableRows
                emptyState={
                  <EmptyState
                    variant="compact"
                    testId="dashboard-backtests-empty"
                    title="No backtests yet"
                    body={
                      <p>
                        Run a strategy over a historical period to see how it
                        would have performed against a benchmark.
                      </p>
                    }
                    actions={
                      <Link
                        className={forms.primaryButton}
                        href="/backtests/new"
                      >
                        Run a backtest
                      </Link>
                    }
                  />
                }
              />
            </SectionCard>
          </>
        ) : null}
      </div>
    </PageContainer>
  );
}
