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
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import forms from "../../../components/ui/forms.module.css";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import {
  formatObservationPrice,
  LEVEL_KIND_LABELS,
} from "../../monitors/utils/format";
import { stockDetailsHref } from "../../stocks/search/utils/stock-routes";
import { useDashboard } from "../hooks/use-dashboard";
import { DashboardOverview } from "./DashboardOverview";
import {
  FRESHNESS_TONES,
  LEVEL_TONES,
  ROW_STATE_FILTER_LABELS,
  ROW_STATE_LABELS,
  ROW_STATE_TONES,
  freshnessLabel,
  levelLabel,
} from "../utils/format";
import styles from "./DashboardPage.module.css";

type StateFilter = "ALL" | DashboardRowState;
type LevelFilter = "ALL" | MonitorLevelKind;

const STATE_FILTERS: readonly { readonly id: StateFilter; readonly label: string }[] =
  [
    { id: "ALL", label: "All" },
    { id: "ACTIVE", label: ROW_STATE_FILTER_LABELS.ACTIVE },
    { id: "PENDING_TRIGGER", label: ROW_STATE_FILTER_LABELS.PENDING_TRIGGER },
  ];

const LEVEL_FILTERS: readonly { readonly value: LevelFilter; readonly label: string }[] =
  [
    { value: "ALL", label: "All actions" },
    { value: "BUY", label: LEVEL_KIND_LABELS.BUY },
    { value: "SELL", label: LEVEL_KIND_LABELS.SELL },
    { value: "FINAL_EXIT", label: LEVEL_KIND_LABELS.FINAL_EXIT },
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

/**
 * The signal table's columns.
 *
 * Strategy, List and Monitor are **three** columns, not one. They are three different objects with
 * three different pages, and collapsing them into one cell made the row's most useful fact — which
 * strategy said this — something the reader had to go looking for. Each is an ordinary entity
 * reference, so the same chip means the same thing here as on a Monitor's own page, and on a phone
 * `DataTable` folds the three into the card's linked block without a second implementation.
 *
 * There is deliberately no per-row Backtest button: it repeated one call to action on every row of
 * a table whose job is to report, and the same backtest is one click away from the Strategy, the
 * List or the Monitor the row already links to.
 */
const COLUMNS: readonly DataTableColumn<DashboardRowResponse>[] = [
  {
    key: "stock",
    header: "Stock",
    cardRole: "identity",
    // A floor under the column that identifies the row: at laptop widths the table's other
    // columns used to squeeze it to "U." (UX-007). The company name still truncates.
    render: (row) => (
      <span className={styles.stockCell}>
        <StockIdentity
          symbol={row.security.symbol}
          name={row.security.name}
          {...(row.security.logoUrl ? { logoUrl: row.security.logoUrl } : {})}
          href={stockDetailsHref(row.security.symbol)}
          size="sm"
          testId="dashboard-stock"
        />
      </span>
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
    key: "strategy",
    header: "Strategy",
    cardRole: "links",
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="strategy"
          name={row.strategy.name}
          href={`/strategies/${row.strategy.id}`}
        />
      </span>
    ),
  },
  {
    key: "list",
    header: "List",
    cardRole: "links",
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="list"
          name={row.stockList.name}
          href={`/lists/${row.stockList.id}`}
        />
      </span>
    ),
  },
  {
    key: "monitor",
    header: "Monitor",
    cardRole: "links",
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="monitor"
          name={row.monitor.name}
          href={`/monitors/${row.monitor.id}`}
        />
      </span>
    ),
  },
];

/**
 * The application home: every current match and setup from the monitors the viewer can see.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 4. One row per monitor outcome — the same
 * stock under two monitors is two rows — showing `ACTIVE` signals and `PENDING_TRIGGER` setups only.
 * A Guest sees the published built-in monitors; a signed-in user sees those they have not hidden,
 * plus their own. Freshness comes from real scan times and is never described as live when it is not.
 *
 * Above the table sits one strip of five cards — `Run Backtest`, the three market references and
 * the current match count — which is V1's Dashboard opening and the shape a returning user
 * recognises. It is context and one action, not a second information architecture: choosing which
 * monitors feed the table is still a property of a monitor and still lives on the Monitors page,
 * because a configuration panel under the signals competed with them for the screen and made the
 * product's home page look like a settings screen.
 */
export function DashboardPage() {
  const { status, dashboard, reload } = useDashboard();
  const { state: session } = useAuthSession();
  const [stateFilter, setStateFilter] = useState<StateFilter>("ALL");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("ALL");
  const now = new Date();

  const rows = dashboard?.rows ?? [];
  const byLevel = rows.filter(
    (row) => levelFilter === "ALL" || row.levelKind === levelFilter,
  );
  const visibleRows = byLevel.filter(
    (row) => stateFilter === "ALL" || row.state === stateFilter,
  );
  const monitors = dashboard?.monitors ?? [];
  const shownMonitors = monitors.filter((monitor) => monitor.visible);
  const guest =
    dashboard?.viewer === "GUEST" || session.status === "unauthenticated";

  return (
    <PageContainer>
      <div className={styles.page} data-testid="dashboard-page">
        <PageHeader
          title="Dashboard"
          lead="Current matches and setups from your monitors, including FactorSage's built-in ones."
          aside={
            dashboard ? (
              <OverallFreshness monitors={shownMonitors} now={now} />
            ) : undefined
          }
        />

        {/* The overview strip, directly under the header and above everything else — V1's own
            placement, and the one that makes the market the context the signals are read in rather
            than a footnote under them. It is given the *unfiltered* rows on purpose: narrowing the
            table below must not change what is matching. */}
        <DashboardOverview rows={rows} rowsReady={status === "ready"} />

        {guest && status === "ready" ? (
          <div className={styles.guestNotice} data-testid="dashboard-guest-notice">
            <p>
              You are viewing FactorSage&apos;s built-in monitors. Sign in to
              choose which ones appear here, create your own, and backtest any
              of them.
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
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={reload}
              >
                Try again
              </button>
            }
          />
        ) : null}

        {status === "ready" && dashboard ? (
          <SectionCard
            id="signals"
            title="Current signals"
            caption="Active signals stay here while their conditions hold. Setups waiting for a trigger become active when it fires."
            flush={rows.length > 0}
            toolbar={
              rows.length > 0 ? (
                <div className={styles.toolbar}>
                  {/*
                    Two different questions, so deliberately two different controls. The state is
                    the primary view and takes the segmented control; the action is a refinement of
                    whatever is on screen and takes a dropdown. Rendering both as pill groups made
                    them look like two competing tab bars.
                  */}
                  <StateFilterGroup
                    value={stateFilter}
                    onChange={setStateFilter}
                    count={(id) =>
                      byLevel.filter((row) => id === "ALL" || row.state === id)
                        .length
                    }
                  />
                  <SelectControl
                    id="dashboard-action-filter"
                    label="Action"
                    value={levelFilter}
                    onChange={(value) => setLevelFilter(value as LevelFilter)}
                    options={LEVEL_FILTERS}
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
                      ? "Turn a monitor back on from the Monitors page to see its matches here."
                      : "Your monitors are running. Matches and setups appear here as soon as a scan finds them."}
                  </p>
                }
                actions={
                  shownMonitors.length === 0 ? (
                    <Link className={forms.secondaryButton} href="/monitors">
                      Go to monitors
                    </Link>
                  ) : undefined
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
                columns={COLUMNS}
                rows={visibleRows}
                getRowKey={(row) => row.id}
              />
            )}
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}

/**
 * The primary view switch: every current row, the active ones, or the setups still waiting.
 *
 * Each option carries the count it would show, so the user can see there is nothing behind a view
 * before opening it.
 */
function StateFilterGroup({
  value,
  onChange,
  count,
}: {
  readonly value: StateFilter;
  readonly onChange: (next: StateFilter) => void;
  readonly count: (id: StateFilter) => number;
}) {
  return (
    <div
      className={styles.filters}
      role="group"
      aria-label="Filter by state"
      data-testid="dashboard-state-filter"
    >
      {STATE_FILTERS.map((option) => (
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
