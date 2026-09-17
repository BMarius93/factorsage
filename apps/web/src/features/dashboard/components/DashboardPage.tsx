"use client";

import type {
  DashboardMonitorResponse,
  DashboardRowResponse,
  DashboardRowState,
  MonitorLevelKind,
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
import { StockIdentity } from "../../../components/ui/StockIdentity";
import actionStyles from "../../../components/ui/actions.module.css";
import forms from "../../../components/ui/forms.module.css";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { formatObservationPrice, LEVEL_KIND_LABELS } from "../../monitors/utils/format";
import { stockDetailsHref } from "../../stocks/search/utils/stock-routes";
import { useDashboard } from "../hooks/use-dashboard";
import {
  FRESHNESS_TONES,
  LEVEL_TONES,
  ROW_STATE_LABELS,
  ROW_STATE_TONES,
  formatAge,
  formatSessionDate,
  freshnessLabel,
  levelLabel,
} from "../utils/format";
import { MonitorVisibilityPanel } from "./MonitorVisibilityPanel";
import styles from "./DashboardPage.module.css";

type StateFilter = "ALL" | DashboardRowState;
type LevelFilter = "ALL" | MonitorLevelKind;

const STATE_FILTERS: readonly { readonly id: StateFilter; readonly label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "ACTIVE", label: ROW_STATE_LABELS.ACTIVE },
  { id: "PENDING_TRIGGER", label: ROW_STATE_LABELS.PENDING_TRIGGER },
];

const LEVEL_FILTERS: readonly { readonly id: LevelFilter; readonly label: string }[] = [
  { id: "ALL", label: "All actions" },
  { id: "BUY", label: LEVEL_KIND_LABELS.BUY },
  { id: "SELL", label: LEVEL_KIND_LABELS.SELL },
  { id: "FINAL_EXIT", label: LEVEL_KIND_LABELS.FINAL_EXIT },
];

function ReasonCell({ row }: { readonly row: DashboardRowResponse }) {
  return (
    <div className={styles.reasons}>
      {row.reasons.map((reason, index) => (
        <p key={index} className={styles.reason}>
          {reason.exitRule !== undefined ? (
            <span className={styles.reasonRule}>Rule {reason.exitRule}: </span>
          ) : null}
          {reason.conditions.join(" and ")}
          {reason.trigger ? (
            <span className={styles.reasonTrigger}>
              {reason.conditions.length > 0 ? " · " : ""}
              {reason.waitingForTrigger ? "Waiting for: " : "Triggered: "}
              {reason.trigger}
            </span>
          ) : null}
        </p>
      ))}
    </div>
  );
}

function SinceCell({ row, now }: { readonly row: DashboardRowResponse; readonly now: Date }) {
  const date = row.observationDate ? formatSessionDate(row.observationDate) : null;
  return (
    <span className={styles.since} title={new Date(row.since).toLocaleString()}>
      {date ?? formatAge(row.since, now)}
      {row.reconstructed ? <span className={styles.sinceNote}>from history</span> : null}
    </span>
  );
}

function columnsFor(now: Date): DataTableColumn<DashboardRowResponse>[] {
  return [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      render: (row) => (
        <StockIdentity
          symbol={row.security.symbol}
          name={row.security.name}
          {...(row.security.logoUrl ? { logoUrl: row.security.logoUrl } : {})}
          href={stockDetailsHref(row.security.symbol)}
          size="sm"
        />
      ),
    },
    {
      key: "action",
      header: "Action",
      cardRole: "status",
      nowrap: true,
      render: (row) => (
        <span className={styles.badges}>
          <StatusBadge
            tone={LEVEL_TONES[row.levelKind]}
            variant="outline"
            dataAttributes={{ "data-level": row.levelKind }}
          >
            {levelLabel(row)}
          </StatusBadge>
          <StatusBadge
            tone={ROW_STATE_TONES[row.state]}
            dataAttributes={{ "data-state": row.state }}
          >
            {ROW_STATE_LABELS[row.state]}
          </StatusBadge>
        </span>
      ),
    },
    {
      key: "reason",
      header: "Why",
      cardLabel: "Why",
      render: (row) => <ReasonCell row={row} />,
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (row) =>
        row.price === undefined ? (
          <span className={styles.placeholder}>—</span>
        ) : (
          formatObservationPrice(row.price)
        ),
    },
    {
      key: "since",
      header: "Since",
      nowrap: true,
      render: (row) => <SinceCell row={row} now={now} />,
    },
    {
      key: "source",
      header: "Monitor",
      cardRole: "links",
      cardLabel: "From",
      render: (row) => (
        <span className={styles.sources}>
          <EntityReferenceChip
            kind="monitor"
            name={row.monitor.name}
            href={`/monitors/${row.monitor.id}`}
          />
          <span className={styles.sourceDetail}>
            <EntityReferenceChip
              kind="strategy"
              name={row.strategy.name}
              href={`/strategies/${row.strategy.id}`}
            />
            <EntityReferenceChip
              kind="list"
              name={row.stockList.name}
              href={`/lists/${row.stockList.id}`}
            />
          </span>
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className={styles.visuallyHidden}>Actions</span>,
      cardRole: "actions",
      nowrap: true,
      render: (row) => (
        <Link
          className={actionStyles.action}
          href={`/backtests/new?strategyId=${encodeURIComponent(row.strategy.id)}&stockListId=${encodeURIComponent(row.stockList.id)}`}
          title={`Backtest ${row.strategy.name} over ${row.stockList.name}`}
        >
          Backtest
        </Link>
      ),
    },
  ];
}

/**
 * The application home: every current match and setup from the monitors the viewer can see.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 4. One row per monitor outcome — the same
 * stock under two monitors is two rows — showing `ACTIVE` signals and `PENDING_TRIGGER` setups only.
 * A Guest sees the published built-in monitors; a signed-in user may hide those and also sees their
 * own. Freshness comes from real scan times and is never described as live when it is not.
 */
export function DashboardPage() {
  const { status, dashboard, reload } = useDashboard();
  const { state: session } = useAuthSession();
  const [stateFilter, setStateFilter] = useState<StateFilter>("ALL");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("ALL");
  const now = new Date();

  const rows = dashboard?.rows ?? [];
  const byState = rows.filter((row) => levelFilter === "ALL" || row.levelKind === levelFilter);
  const visibleRows = byState.filter(
    (row) => stateFilter === "ALL" || row.state === stateFilter,
  );
  const monitors = dashboard?.monitors ?? [];
  const shownMonitors = monitors.filter((monitor) => monitor.visible);
  const guest = dashboard?.viewer === "GUEST" || session.status === "unauthenticated";

  return (
    <PageContainer>
      <div className={styles.page} data-testid="dashboard-page">
        <PageHeader
          title="Dashboard"
          lead="Current matches and setups from your monitors, including FactorSage's built-in ones."
          aside={dashboard ? <OverallFreshness monitors={shownMonitors} now={now} /> : undefined}
        />

        {guest && status === "ready" ? (
          <div className={styles.guestNotice} data-testid="dashboard-guest-notice">
            <p>
              You are viewing FactorSage&apos;s built-in monitors. Sign in to choose which ones
              appear here, create your own, and backtest any of them.
            </p>
            <Link className={forms.tintedButton} href="/login">
              Sign in
            </Link>
          </div>
        ) : null}

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading dashboard">
            <SkeletonList rows={6} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="The dashboard could not be loaded"
            body={<p>This is usually temporary — try again in a moment.</p>}
            actions={
              <button type="button" className={forms.secondaryButton} onClick={reload}>
                Try again
              </button>
            }
          />
        ) : null}

        {status === "ready" && dashboard ? (
          <>
            <SectionCard
              id="signals"
              title="Current signals"
              caption="Active signals stay here while their conditions hold. Setups waiting for a trigger become active when it fires."
              flush={rows.length > 0}
              toolbar={
                rows.length > 0 ? (
                  <div className={styles.toolbar}>
                    <FilterGroup
                      label="Filter by state"
                      options={STATE_FILTERS}
                      value={stateFilter}
                      onChange={setStateFilter}
                      count={(id) =>
                        byState.filter((row) => id === "ALL" || row.state === id).length
                      }
                      testId="dashboard-state-filter"
                    />
                    <FilterGroup
                      label="Filter by action"
                      options={LEVEL_FILTERS}
                      value={levelFilter}
                      onChange={setLevelFilter}
                      count={(id) =>
                        rows.filter(
                          (row) =>
                            (id === "ALL" || row.levelKind === id) &&
                            (stateFilter === "ALL" || row.state === stateFilter),
                        ).length
                      }
                      testId="dashboard-level-filter"
                    />
                  </div>
                ) : null
              }
            >
              {rows.length === 0 ? (
                <EmptyState
                  variant="compact"
                  testId="dashboard-signals-empty"
                  title={
                    shownMonitors.length === 0
                      ? "No monitors are shown"
                      : "Nothing is matching right now"
                  }
                  body={
                    <p>
                      {shownMonitors.length === 0
                        ? "Turn a monitor on below to see its matches here."
                        : "Your monitors are running. Matches and setups appear here as soon as a scan finds them."}
                    </p>
                  }
                />
              ) : visibleRows.length === 0 ? (
                <EmptyState
                  variant="compact"
                  testId="dashboard-signals-filtered-empty"
                  title="No signals match these filters"
                />
              ) : (
                <DataTable
                  label="Current signals"
                  testId="dashboard-signals"
                  rowTestId="dashboard-signal-row"
                  clickableRows
                  columns={columnsFor(now)}
                  rows={visibleRows}
                  getRowKey={(row) => row.id}
                />
              )}
            </SectionCard>

            <MonitorVisibilityPanel
              monitors={monitors}
              guest={guest}
              now={now}
              onChanged={reload}
            />
          </>
        ) : null}
      </div>
    </PageContainer>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  count,
  testId,
}: {
  readonly label: string;
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly count: (id: T) => number;
  readonly testId: string;
}) {
  return (
    <div className={styles.filters} role="group" aria-label={label} data-testid={testId}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={styles.filter}
          data-active={value === option.id ? "true" : undefined}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          <span className={styles.filterCount}>{count(option.id)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The page-level freshness fact: the newest scan among the monitors shown, and a warning when any
 * of them is stale. A Dashboard is never labelled live when its scans are not current.
 */
function OverallFreshness({
  monitors,
  now,
}: {
  readonly monitors: readonly DashboardMonitorResponse[];
  readonly now: Date;
}) {
  const scanned = monitors
    .map((monitor) => monitor.lastScanAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const newest = scanned[scanned.length - 1];
  const stale = monitors.some((monitor) => monitor.freshness === "STALE");
  const freshness = stale ? "STALE" : newest ? "CURRENT" : "NOT_SCANNED";
  return (
    <StatusBadge tone={FRESHNESS_TONES[freshness]} testId="dashboard-freshness">
      {freshnessLabel(freshness, newest, now)}
    </StatusBadge>
  );
}
