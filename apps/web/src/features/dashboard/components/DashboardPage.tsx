"use client";

import type {
  DashboardMonitorResponse,
  DashboardRowResponse,
  DashboardRowState,
  MonitorLevelKind,
} from "@intrinsic/contracts";
import Link from "next/link";
import { createContext, useContext, useState } from "react";
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
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import forms from "../../../components/ui/forms.module.css";
import { formatDateTime } from "../../../lib/dates";
import { useNow } from "../../../lib/use-now";
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
  formatAge,
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
 * Strategy, List and Monitor as one line under the stock, for the intermediate desktop band
 * (880–1,279px) only (UI-003). There, three chip columns beside the reason and the price were
 * squeezed to "QA Bu…" and a lone "("; the three columns step out (`foldIntermediate`) and the
 * same references read here in full width instead. Outside that band this block is not
 * displayed, so the references are never exposed twice.
 */
function FoldedRelationships({ row }: { readonly row: DashboardRowResponse }) {
  return (
    <IntermediateOnly testId="dashboard-folded-relationships">
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
      <EntityReferenceChip
        kind="monitor"
        name={row.monitor.name}
        href={`/monitors/${row.monitor.id}`}
      />
    </IntermediateOnly>
  );
}

/** How long the row's state has held, from `since`; the reconstruction marker when it applies. */
function SinceCell({ row }: { readonly row: DashboardRowResponse }) {
  const now = useContext(NowContext);
  return (
    <span className={styles.since} data-testid="dashboard-since">
      <time dateTime={row.since}>
        {formatAge(row.since, now)}
        <span className={styles.srOnly}> ({formatDateTime(row.since)})</span>
      </time>
      {row.reconstructed ? (
        <span className={styles.sinceNote}>from history</span>
      ) : null}
    </span>
  );
}

/**
 * The table's default order (UI-025): what is actionable first — active signals before setups
 * still waiting for a trigger — then by action (BUY, SELL, FINAL EXIT, then level order), then the
 * newest state change first. The API sends newest-first; that stays the final tie-break, and the
 * same security under two monitors is still two rows.
 */
const STATE_ORDER: Record<DashboardRowState, number> = { ACTIVE: 0, PENDING_TRIGGER: 1 };
const LEVEL_ORDER: Record<MonitorLevelKind, number> = { BUY: 0, SELL: 1, FINAL_EXIT: 2 };

export function sortDashboardRows(
  rows: readonly DashboardRowResponse[],
): DashboardRowResponse[] {
  return [...rows].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      LEVEL_ORDER[a.levelKind] - LEVEL_ORDER[b.levelKind] ||
      (a.levelIndex ?? 0) - (b.levelIndex ?? 0) ||
      b.since.localeCompare(a.since),
  );
}

/** The ticking clock every relative label on the page reads (`useNow`). */
const NowContext = createContext<Date>(new Date(0));

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
    // columns used to squeeze it to "U." (UX-007). The mark plus a full seven-character ticker;
    // the company name still truncates.
    minWidth: "7rem",
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
        <FoldedRelationships row={row} />
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
    // When the present state began (UI-025): a signal says how long it has held, not just that it
    // holds. Relative and ticking, with the exact time beside it for keyboard and screen readers.
    key: "since",
    header: "Since",
    nowrap: true,
    render: (row) => <SinceCell row={row} />,
  },
  {
    key: "reason",
    header: "Why",
    cardLabel: "Why",
    stacked: true,
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
    foldIntermediate: true,
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
    foldIntermediate: true,
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
    foldIntermediate: true,
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
  // One clock for the page, ticking while it stays open, so "Updated 12 min ago" and every row's
  // age stay true without refetching (UI-048).
  const now = useNow(30_000);

  const rows = sortDashboardRows(dashboard?.rows ?? []);
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
                  <SegmentedControl
                    label="Filter by state"
                    testId="dashboard-state-filter"
                    value={stateFilter}
                    onChange={setStateFilter}
                    options={STATE_FILTERS.map((option) => ({
                      value: option.id,
                      label: option.label,
                      count: byLevel.filter(
                        (row) => option.id === "ALL" || row.state === option.id,
                      ).length,
                    }))}
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
                actions={
                  <button
                    type="button"
                    className={forms.secondaryButton}
                    onClick={() => {
                      setStateFilter("ALL");
                      setLevelFilter("ALL");
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              <NowContext.Provider value={now}>
              <DataTable
                label="Current signals"
                testId="dashboard-signals"
                rowTestId="dashboard-signal-row"
                clickableRows
                columns={COLUMNS}
                rows={visibleRows}
                getRowKey={(row) => row.id}
              />
              </NowContext.Provider>
            )}
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
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
