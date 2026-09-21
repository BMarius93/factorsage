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
import { SectionCard } from "../../../components/ui/SectionCard";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import { signInHref } from "../../auth/utils/guest-routes";
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
            <span className={styles.reasonRule}>Exit rule {reason.exitRule}: </span>
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
        variant="quiet"
      />
      <EntityReferenceChip
        kind="list"
        name={row.stockList.name}
        href={`/lists/${row.stockList.id}`}
        variant="quiet"
      />
      <EntityReferenceChip
        kind="monitor"
        name={row.monitor.name}
        href={`/monitors/${row.monitor.id}`}
        variant="quiet"
      />
    </IntermediateOnly>
  );
}

/**
 * How long the row's state has held, from `since`.
 *
 * Only the age. `row.reconstructed` — whether the lifecycle was rebuilt from Signal history
 * rather than observed live — is a real and meaningful fact about the *engine*
 * (`docs/decisions/builtin-dashboard-signals-v1.md`), and it stays in the contract and on the
 * Monitor's own page. It is not a fact about this stock: "from history" under a date told a
 * reader on the product's home page nothing they could act on, in the voice of a debug log.
 */
function SinceCell({ row }: { readonly row: DashboardRowResponse }) {
  const now = useContext(NowContext);
  return (
    <span className={styles.since} data-testid="dashboard-since">
      <time dateTime={row.since}>
        {formatAge(row.since, now)}
        <span className={styles.srOnly}> ({formatDateTime(row.since)})</span>
      </time>
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
 * The floor under Strategy, List and Monitor.
 *
 * Eight columns sharing a 1,440px table left these three at the width of "Trend C…", which is
 * where three distinguishable objects stopped being distinguishable. Each is now one quiet pill on
 * one line (`EntityReferenceChip variant="quiet"`) that sizes to its name up to the chip's own cap
 * and truncates with an ellipsis past it, the whole name in its tooltip — never a two-line pill.
 * `Why` keeps its own floor and its 26rem ceiling, so it stays the dominant column it should be.
 *
 * The value is the widest the table can afford at **1,280px** — the narrowest width at which all
 * eight columns are shown, since 880–1,279px folds these three out. What the other five need there
 * is not negotiable (the ticker, a `Waiting for trigger` badge, a relative time, the reason and a
 * price), and what is left over is this. Asking for more does not make the column wider: it makes
 * `DataTable`'s safety valve scroll the table sideways inside its surface, which is worse than a
 * name truncating. Measured against the QA fixtures, which carry the longest action badge.
 */
const RELATIONSHIP_COLUMN_MIN_WIDTH = "9.5rem";

/**
 * The share of the table Strategy, List and Monitor ask for above their floor.
 *
 * Without it they never got the width. Auto table layout shares spare width out in proportion to
 * each column's longest content, and the Stock column's full company names and the Why sentences
 * outbid a pill every time: at 1,600px "Trend Confirmation" was still three pixels short. A
 * percentage is served before the auto columns grow, and because it is a share of the table it
 * grows with the screen: from 1,440px every list and strategy name of about twenty characters
 * reads whole, and the width comes out of the two columns that already wrap or truncate gracefully.
 * At 1,280px it costs Stock and Why about 14px each, and the floors above are untouched, so the
 * table still never scrolls sideways.
 */
const RELATIONSHIP_COLUMN_WIDTH = "14%";

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
    //
    // `--column-min-width` is a border-box floor, so this has to cover the cell's own 32px of
    // padding as well as the 28px mark, its 10px gap and the widest ticker the catalog allows
    // (`QATEST1`, 53px at 13px/600). 7rem left 44px for a 53px ticker and only ever worked
    // because auto table layout handed the column more than its floor — which stopped being true
    // once Strategy, List and Monitor were given floors of their own.
    minWidth: "8.5rem",
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
    //
    // On a phone it is a `summary` cell: "3 days ago" needs no "SINCE" label above it, and paying
    // a labelled row for it — and another for the price — is how a card grew to a screenful.
    key: "since",
    header: "Since",
    cardRole: "summary",
    nowrap: true,
    render: (row) => <SinceCell row={row} />,
  },
  {
    key: "reason",
    header: "Why",
    // No visible label on a card: the value is already a sentence about why this row is here.
    // The column header still labels the cell for assistive technology.
    cardLabel: null,
    stacked: true,
    render: (row) => <ReasonCell row={row} />,
  },
  {
    key: "price",
    header: "Price",
    // Shares the card's summary line with `since`, at the other end of it.
    cardRole: "summary",
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
    // A floor under the name, because these three columns are what the reader distinguishes one
    // row from another by; the pill truncates inside it rather than the column narrowing past it.
    minWidth: RELATIONSHIP_COLUMN_MIN_WIDTH,
    width: RELATIONSHIP_COLUMN_WIDTH,
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="strategy"
          name={row.strategy.name}
          href={`/strategies/${row.strategy.id}`}
          variant="quiet"
        />
      </span>
    ),
  },
  {
    key: "list",
    foldIntermediate: true,
    header: "List",
    cardRole: "links",
    // A floor under the name, because these three columns are what the reader distinguishes one
    // row from another by; the pill truncates inside it rather than the column narrowing past it.
    minWidth: RELATIONSHIP_COLUMN_MIN_WIDTH,
    width: RELATIONSHIP_COLUMN_WIDTH,
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="list"
          name={row.stockList.name}
          href={`/lists/${row.stockList.id}`}
          variant="quiet"
        />
      </span>
    ),
  },
  {
    key: "monitor",
    foldIntermediate: true,
    header: "Monitor",
    cardRole: "links",
    // A floor under the name, because these three columns are what the reader distinguishes one
    // row from another by; the pill truncates inside it rather than the column narrowing past it.
    minWidth: RELATIONSHIP_COLUMN_MIN_WIDTH,
    width: RELATIONSHIP_COLUMN_WIDTH,
    render: (row) => (
      <span className={styles.entityCell}>
        <EntityReferenceChip
          kind="monitor"
          name={row.monitor.name}
          href={`/monitors/${row.monitor.id}`}
          variant="quiet"
        />
      </span>
    ),
  },
];

/**
 * The application home, at `/`: every current match and setup from the monitors the viewer can see.
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
        {/* The page's one heading, and nothing else of the header that used to sit here.
            A card saying "Dashboard" over a sentence explaining what a dashboard is, with the
            freshness pill parked in its corner, spent the whole first screen of the product's
            home page introducing it to a reader who had arrived on purpose. The name is still
            the document's `h1` — in the tab title, in the landmark tree and under a screen
            reader's heading key — it just is not a 120px card any more. */}
        <h1 className={styles.srOnly}>Dashboard</h1>

        {/* The overview strip is now the first thing on the page — V1's own placement, and the
            one that makes the market the context the matches are read in rather than a footnote
            under them. It is given the *unfiltered* rows on purpose: narrowing the table below
            must not change what is matching. */}
        <DashboardOverview rows={rows} rowsReady={status === "ready"} />

        {guest && status === "ready" ? (
          <div className={styles.guestNotice} data-testid="dashboard-guest-notice">
            <p>
              You are viewing FactorSage&apos;s built-in monitors. Sign in to
              choose which ones appear here, create your own, and backtest any
              of them.
            </p>
            <Link className={forms.tintedButton} href={signInHref()}>
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
            title="Current matches"
            caption="Active matches stay here while their conditions hold. Setups waiting for a trigger become active when it fires."
            // Freshness reads as a detail of the matches, beside the heading they belong to,
            // rather than as a page-level announcement (UI-048). The scan times behind it are
            // unchanged: it is still the newest `lastScanAt` of the monitors on screen, and it
            // still refuses to call a stale Dashboard current.
            aside={<OverallFreshness monitors={shownMonitors} now={now} />}
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
                title="No matches for these filters"
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
                label="Current matches"
                testId="dashboard-signals"
                rowTestId="dashboard-signal-row"
                clickableRows
                columns={COLUMNS}
                rows={visibleRows}
                getRowKey={(row) => row.id}
              />
              </NowContext.Provider>
            )}
            {/* What the rows above are, in one sentence, from the one shared copy source. Placed
                inside the section so it travels with the signals rather than floating at the
                bottom of a page that may also be showing market cards. */}
            <DisclosureNote id="signals" className={styles.disclosure} />
          </SectionCard>
        ) : null}
      </div>
    </PageContainer>
  );
}

/**
 * How fresh the matches are: the newest scan among the monitors shown, and a warning when any of
 * them is stale. A Dashboard is never labelled live when its scans are not current.
 *
 * Two treatments, because they are two different statements. `Updated 4 min ago` is reassurance —
 * quiet text beside the section's heading, where a reader can find it and nothing else has to make
 * room for it. Anything else is a caveat about what they are looking at, and keeps the badge it has
 * always had, because a stale or never-scanned Dashboard has to say so at a glance.
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
  const label = freshnessLabel(freshness, newest, now);

  if (freshness === "CURRENT") {
    return (
      <span className={styles.freshness} data-testid="dashboard-freshness">
        {label}
      </span>
    );
  }

  return (
    <StatusBadge tone={FRESHNESS_TONES[freshness]} testId="dashboard-freshness">
      {label}
    </StatusBadge>
  );
}
