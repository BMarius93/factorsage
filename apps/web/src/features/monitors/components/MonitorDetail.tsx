"use client";

import {
  MONITOR_SECURITY_STATUSES,
  type MonitorCoverageResponse,
  type MonitorDetailResponse,
  type MonitorLevelKind,
  type MonitorSecurityStatus,
  type MonitorSignalRowResponse,
  type UpdateMonitorRequest,
  type MonitorSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LinkedEntities } from "../../../components/ui/EntityReference";
import { FactGrid } from "../../../components/ui/FactGrid";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { DisclosureNote } from "../../legal/components/DisclosureNote";
import { DetailSkeleton, SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import forms from "../../../components/ui/forms.module.css";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../../../components/ui/SegmentedControl";
import { formatDay, formatRelative } from "../../../lib/dates";
import { SelectControl } from "../../../components/ui/SelectControl";
import { etfSourceLines } from "../utils/etf-sources";
import { useNow } from "../../../lib/use-now";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { stockCountLabel } from "../../lists/utils/format";
import { deleteMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitor } from "../hooks/use-monitor";
import {
  useMonitorSignals,
  type SignalTableFilters,
} from "../hooks/use-monitor-signals";
import { MonitorWhy } from "./MonitorWhy";
import {
  blockedExplanation,
  isBlockedByEntitlement,
  MonitorStateBadge,
} from "../utils/blocked-status";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { RunBacktestLink } from "../../backtests/components/RunBacktestLink";
import {
  activeSignalLabel,
  formatObservationPrice,
  lastScanLabel,
  LEVEL_KIND_LABELS,
  levelPositionLabel,
  SIGNAL_ROW_STATE_TONES,
  signalRowStatusLabel,
} from "../utils/format";
import { MonitorFormDialog } from "./MonitorFormDialog";
import { BuiltInEditNotice } from "../../../components/ui/BuiltInEditNotice";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { LEVEL_KIND_TONES } from "../../strategies/utils/format";
import { summarizeStockSectors } from "../../strategies/utils/stock-sector-assignments";
import styles from "./MonitorDetail.module.css";

type DialogState = { kind: "closed" } | { kind: "edit" } | { kind: "delete" };

type StateView = "ALL" | "ACTIVE" | "RESOLVED" | "PENDING_TRIGGER";
type LevelView = "ALL" | MonitorLevelKind;

const STATE_VIEWS: readonly SegmentedOption<StateView>[] = [
  { value: "ALL", label: "Active & ended" },
  { value: "ACTIVE", label: "Active" },
  { value: "RESOLVED", label: "Ended" },
  { value: "PENDING_TRIGGER", label: "Waiting" },
];

const LEVEL_VIEWS: readonly {
  readonly value: LevelView;
  readonly label: string;
}[] = [
  { value: "ALL", label: "All actions" },
  { value: "BUY", label: LEVEL_KIND_LABELS.BUY },
  { value: "SELL", label: LEVEL_KIND_LABELS.SELL },
  { value: "FINAL_EXIT", label: LEVEL_KIND_LABELS.FINAL_EXIT },
];

/** How a status count reads on the coverage line: `12 matching`, `3 not evaluable`. */
const STATUS_COUNT_LABELS: Record<MonitorSecurityStatus, string> = {
  MATCHED: "matching",
  WAITING_FOR_TRIGGER: "waiting for a trigger",
  NO_MATCH: "no match",
  NOT_EVALUABLE: "not evaluable",
  NOT_CHECKED: "not checked yet",
};

/** `Evaluated through the Oct 13, 2026 close · 497 of 500 current members`. */
export function coverageLabel(coverage: MonitorCoverageResponse): string {
  const members = `${coverage.currentMembers} current ${
    coverage.currentMembers === 1 ? "member" : "members"
  }`;
  if (coverage.currentMembers === 0) {
    return "No current members to evaluate";
  }
  if (coverage.latestSession === undefined) {
    return `Not evaluated yet · ${members}`;
  }
  return `Evaluated through the ${formatDay(coverage.latestSession)} close · ${
    coverage.evaluatedMembers
  } of ${members}`;
}

/** The date a Signal row is told by: when it ended, or since when it holds. */
function rowDateLabel(row: MonitorSignalRowResponse): string {
  return row.state === "RESOLVED"
    ? `Ended ${formatDay(row.sessionDate)}`
    : `Since ${formatDay(row.sessionDate)}`;
}

function Placeholder() {
  return <span className={styles.placeholder}>—</span>;
}

/**
 * The Signal table's columns (`docs/decisions/monitor-eod-v2.md` §6): the stock, the signal and its
 * status in one badge pair, the session it is dated by, why, and the price it activated at.
 */
const SIGNAL_COLUMNS: readonly DataTableColumn<MonitorSignalRowResponse>[] = [
  {
    key: "stock",
    header: "Stock",
    cardRole: "identity",
    render: (row) => (
      <StockIdentity
        symbol={row.security.symbol}
        name={row.security.name}
        {...(row.security.logoUrl ? { logoUrl: row.security.logoUrl } : {})}
        href={`/stocks/${encodeURIComponent(row.security.symbol)}`}
      />
    ),
  },
  {
    key: "signal",
    header: "Signal",
    cardRole: "status",
    render: (row) => (
      <span className={styles.levels}>
        <StatusBadge
          tone={LEVEL_KIND_TONES[row.levelKind]}
          variant="outline"
          dataAttributes={{ "data-kind": row.levelKind }}
        >
          {levelPositionLabel(row)}
        </StatusBadge>
        <StatusBadge
          tone={SIGNAL_ROW_STATE_TONES[row.state]}
          testId="monitor-signal-status"
          dataAttributes={{ "data-state": row.state }}
        >
          {signalRowStatusLabel(row)}
        </StatusBadge>
      </span>
    ),
  },
  {
    key: "date",
    header: "Date",
    cardRole: "summary",
    nowrap: true,
    render: (row) => (
      <span className={styles.rowDate} data-testid="monitor-signal-date">
        <time dateTime={row.sessionDate}>{rowDateLabel(row)}</time>
        {row.fromHistory ? (
          <span
            className={styles.fromHistory}
            data-testid="monitor-signal-history"
          >
            From history
          </span>
        ) : null}
        {row.observationBasis === "LIVE_QUOTE" ? (
          <span className={styles.fromHistory}>Intraday quote</span>
        ) : null}
      </span>
    ),
  },
  {
    key: "why",
    header: "Why",
    cardLabel: null,
    stacked: true,
    render: (row) => <MonitorWhy why={row.why} />,
  },
  {
    key: "price",
    header: "Price",
    cardRole: "summary",
    align: "right",
    numeric: true,
    nowrap: true,
    render: (row) =>
      row.activationPrice === undefined ? (
        <Placeholder />
      ) : (
        formatObservationPrice(row.activationPrice)
      ),
  },
];

/**
 * One monitor: what it watches, what its current evaluation says, and the Signals it produced.
 *
 * Everything rendered here comes from one request. The status of each security is a projection of
 * the worker's durable state — the browser never re-runs a Strategy, and a status the backend did
 * not record is not inferred.
 */
export function MonitorDetail({ monitorId }: { readonly monitorId: string }) {
  const router = useRouter();
  const { status, monitor, reload } = useMonitor(monitorId);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [togglePending, setTogglePending] = useState(false);
  const [toggleFailure, setToggleFailure] = useState<string | null>(null);
  const [local, setLocal] = useState<MonitorSummaryResponse | null>(null);
  const [stateView, setStateView] = useState<StateView>("ALL");
  const [levelView, setLevelView] = useState<LevelView>("ALL");
  const filters: SignalTableFilters = {
    ...(stateView === "ALL" ? {} : { state: stateView }),
    ...(levelView === "ALL" ? {} : { levelKind: levelView }),
  };
  const signalTable = useMonitorSignals(monitorId, filters);
  const now = useNow(30_000);
  useDocumentTitle(local?.name ?? monitor?.name);

  const closeDialog = () => setDialog({ kind: "closed" });

  if (status === "loading") {
    return (
      <PageContainer>
        <DetailSkeleton
          thing="monitor"
          back={{ href: "/monitors", label: "Monitors" }}
        />
      </PageContainer>
    );
  }

  if (status === "missing") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            testId="monitor-missing"
            title="Monitor not found"
            body={
              <p>It may have been deleted, or it belongs to another account.</p>
            }
            actions={
              <Link className={forms.secondaryButton} href="/monitors">
                Back to Monitors
              </Link>
            }
          />
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || monitor === null) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            variant="error"
            title="This monitor could not be loaded"
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
        </div>
      </PageContainer>
    );
  }

  // A toggle answers with the fresh summary, which is authoritative for the header while the
  // evaluation table below it is unchanged by enabling or disabling.
  const view: MonitorDetailResponse =
    local === null ? monitor : { ...monitor, ...local };

  const builtIn = view.ownership === "SYSTEM";

  // One path for every switch this page owns: a customer's `enabled`, and an administrator's
  // `isPublished` and `isGloballyEnabled` on a built-in.
  const patchSwitch = async (patch: UpdateMonitorRequest) => {
    if (togglePending) {
      return;
    }
    setTogglePending(true);
    setToggleFailure(null);
    try {
      setLocal(await updateMonitor(view.id, patch));
    } catch (error) {
      // Enabling one monitor too many is a plan limit, not a failed save — the same refusal the
      // collection shows for the same action, in the API's own words.
      setToggleFailure(
        requestFailureMessage(
          error,
          "That change did not save. This monitor is unchanged.",
        ),
      );
    } finally {
      setTogglePending(false);
    }
  };
  const toggle = () =>
    patchSwitch(
      builtIn
        ? { isGloballyEnabled: !view.enabled }
        : { enabled: !view.enabled },
    );

  const etfSources = etfSourceLines(view.etfSources);
  // Which sector ETF each watched stock's Stock's Sector rules read now, and which stocks have none.
  const stockSectors = view.stockSectors
    ? summarizeStockSectors(view.stockSectors)
    : null;
  // The status of the current members, as one compact line rather than a per-stock table.
  const statusCounts = Object.fromEntries(
    MONITOR_SECURITY_STATUSES.map((status) => [
      status,
      view.securities.filter((entry) => entry.status === status).length,
    ]),
  ) as Record<MonitorSecurityStatus, number>;
  const statusLine = MONITOR_SECURITY_STATUSES.filter(
    (status) => statusCounts[status] > 0,
  )
    .map((status) => `${statusCounts[status]} ${STATUS_COUNT_LABELS[status]}`)
    .join(" · ");
  const outsideMembership = view.coverage
    ? view.coverage.listedMembers - view.coverage.currentMembers
    : 0;

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitor-detail">
        <PageHeader
          // Always the owning collection (UI-016), for a built-in too: that is where it was found.
          back={{ href: "/monitors", label: "Monitors" }}
          title={view.name}
          badges={
            <>
              {builtIn ? (
                <StatusBadge
                  tone="neutral"
                  variant="outline"
                  testId="built-in-badge"
                >
                  Built-in
                </StatusBadge>
              ) : null}
              {/* One effective state, exactly as on the collection (UI-021). The configured
                  switch is a secondary fact under Configuration. */}
              <MonitorStateBadge monitor={view} builtIn={builtIn} />
              {builtIn && view.canEdit ? (
                <StatusBadge
                  tone={view.isPublished ? "positive" : "warning"}
                  testId="monitor-published-pill"
                >
                  {view.isPublished ? "Published" : "Unpublished"}
                </StatusBadge>
              ) : null}
            </>
          }
          actions={
            !view.canEdit ? (
              <RunBacktestLink
                prefill={{
                  strategyId: view.strategyId,
                  stockListId: view.stockListId,
                }}
                testId="backtest-this-monitor"
              />
            ) : builtIn ? (
              <>
                <RunBacktestLink
                  prefill={{
                    strategyId: view.strategyId,
                    stockListId: view.stockListId,
                  }}
                />
                <button
                  type="button"
                  className={forms.tintedButton}
                  data-testid="edit-monitor"
                  onClick={() => setDialog({ kind: "edit" })}
                >
                  Edit monitor
                </button>
                <OverflowMenu
                  label={view.name}
                  testId="monitor-detail-actions"
                  items={[
                    {
                      label: view.enabled
                        ? "Pause for everyone"
                        : "Resume for everyone",
                      disabled: togglePending,
                      onSelect: toggle,
                      testId: "toggle-monitor",
                    },
                    {
                      label: view.isPublished ? "Unpublish" : "Publish",
                      disabled: togglePending,
                      onSelect: () =>
                        patchSwitch({ isPublished: !view.isPublished }),
                      testId: "publish-monitor",
                    },
                  ]}
                />
              </>
            ) : (
              <>
                {/* The owner's monitor offers the same next step a built-in does (UI-008). */}
                <RunBacktestLink
                  prefill={{
                    strategyId: view.strategyId,
                    stockListId: view.stockListId,
                  }}
                />
                <button
                  type="button"
                  className={forms.tintedButton}
                  data-testid="edit-monitor"
                  onClick={() => setDialog({ kind: "edit" })}
                >
                  Edit monitor
                </button>
                <OverflowMenu
                  label={view.name}
                  testId="monitor-detail-actions"
                  items={[
                    {
                      label: view.enabled
                        ? togglePending
                          ? "Disabling…"
                          : "Disable"
                        : togglePending
                          ? "Enabling…"
                          : "Enable",
                      disabled: togglePending,
                      onSelect: toggle,
                      testId: "toggle-monitor",
                    },
                    {
                      label: "Delete monitor",
                      tone: "danger",
                      separated: true,
                      onSelect: () => setDialog({ kind: "delete" }),
                      testId: "delete-monitor",
                    },
                  ]}
                />
              </>
            )
          }
        />
        {builtIn && view.canEdit ? <BuiltInEditNotice thing="monitor" /> : null}

        {!builtIn && view.enabled && isBlockedByEntitlement(view) ? (
          <EntitlementNotice
            announce="status"
            testId="monitor-blocked-explanation"
            title="Paused by your plan"
            message={blockedExplanation(view.blockedReason)}
            {...(view.blockedReason === "LIST_OVER_LIMIT"
              ? {
                  recovery: (
                    <Link
                      className={forms.secondaryButton}
                      href={`/lists/${view.stockListId}`}
                    >
                      Open the list
                    </Link>
                  ),
                }
              : {})}
          />
        ) : null}

        {toggleFailure ? (
          <p className={forms.error} role="alert">
            {toggleFailure}
          </p>
        ) : null}

        <SectionCard
          id="monitor-configuration"
          title="Configuration"
          caption="A monitor is one strategy, watched over one stock list, decided on each session's finalized close."
        >
          <div className={styles.configuration}>
            {/* The two references are what a Monitor *is*; the counts below are what it has
                done so far. Keeping them apart is what makes the model readable. */}
            <LinkedEntities
              entities={[
                {
                  label: "Strategy",
                  kind: "strategy",
                  name: view.strategyName,
                  href: `/strategies/${view.strategyId}`,
                },
                {
                  label: "Stock list",
                  kind: "list",
                  name: view.stockListName,
                  href: `/lists/${view.stockListId}`,
                },
              ]}
            />
            <FactGrid
              facts={[
                { label: "Stocks", value: stockCountLabel(view.securityCount) },
                ...(builtIn
                  ? []
                  : [
                      {
                        // What the user asked for, which a plan limit never changes; the badge
                        // above is what the system is doing with it.
                        label: "Monitoring",
                        value: view.enabled ? "Switched on" : "Switched off",
                        testId: "monitor-configured-intent",
                      },
                    ]),
                {
                  label: "Active signals",
                  value: activeSignalLabel(view.activeSignalCount),
                },
                {
                  label: "Last checked",
                  // The exact time, and how long ago — kept ticking while the page is open (UI-048).
                  value:
                    view.lastScanAt === undefined
                      ? lastScanLabel(view.lastScanAt)
                      : `${lastScanLabel(view.lastScanAt)} · ${formatRelative(view.lastScanAt, now)}`,
                  testId: "monitor-last-checked",
                },
              ]}
            />
          </div>
        </SectionCard>

        <SectionCard
          id="monitor-signals"
          title="Signals"
          flush={signalTable.status === "ready" && signalTable.rows.length > 0}
          toolbar={
            <div className={styles.toolbar}>
              <SegmentedControl
                label="Filter by state"
                testId="monitor-signal-state-filter"
                value={stateView}
                onChange={setStateView}
                options={STATE_VIEWS}
              />
              <SelectControl
                id="monitor-signal-level-filter"
                label="Action"
                value={levelView}
                onChange={(value) => setLevelView(value as LevelView)}
                options={LEVEL_VIEWS}
                testId="monitor-signal-level-filter"
              />
            </div>
          }
        >
          <div className={styles.coverage} data-testid="monitor-coverage">
            {view.coverage ? (
              <p
                className={styles.coverageLine}
                data-testid="monitor-coverage-line"
              >
                {coverageLabel(view.coverage)}
              </p>
            ) : null}
            {statusLine ? (
              <p
                className={styles.statusLine}
                data-testid="monitor-status-line"
              >
                {statusLine}
              </p>
            ) : null}
            {outsideMembership > 0 ? (
              <p
                className={styles.statusLine}
                data-testid="monitor-outside-membership"
              >
                {outsideMembership} list{" "}
                {outsideMembership === 1 ? "member is" : "members are"} not a
                current member — no open-ended membership that has begun — and{" "}
                {outsideMembership === 1 ? "is" : "are"} not monitored.
              </p>
            ) : null}
          </div>
          {etfSources || stockSectors ? (
            // A stock's session is decided only once every fund its rules read holds that same
            // session, so a fund's state explains a wait.
            <p className={styles.sectionNote} data-testid="monitor-etf-sources">
              <strong>ETF conditions</strong> are decided on the fund&apos;s own
              finalized session, the same one as the stock&apos;s; a stock waits
              for its fund&apos;s session for up to four days, so a late bar is
              decided on its own session.{" "}
              {(etfSources ?? []).map((source, index) => (
                <span
                  key={source.code}
                  data-testid="monitor-etf-source"
                  data-ticker={source.ticker}
                  data-ready={source.ready ? "true" : "false"}
                >
                  {index === 0 ? "" : " · "}
                  <strong>{source.ticker}</strong>: {source.text}
                </span>
              ))}
              {etfSources ? "." : null}
              {stockSectors ? (
                <span
                  data-testid="monitor-stock-sectors"
                  data-unresolved={String(stockSectors.unresolvedCount)}
                >
                  {" "}
                  <strong>Stock&apos;s Sector</strong>:{" "}
                  {stockSectors.resolved ?? "no stock has a sector ETF"}
                  {stockSectors.unresolved
                    ? `; no sector ETF for ${stockSectors.unresolved}, so ${
                        stockSectors.unresolvedCount === 1 ? "its" : "their"
                      } Stock's Sector rules cannot be evaluated`
                    : ""}
                  .
                </span>
              ) : null}
            </p>
          ) : null}
          {statusCounts.NOT_EVALUABLE > 0 ? (
            <p
              className={styles.sectionNote}
              data-testid="monitor-not-evaluable-note"
            >
              <strong>Not evaluable</strong> means the last evaluated session
              could not decide the rule for that stock — for example its price
              history is too short for a metric, or a value such as intrinsic
              value is not available. It is not the same as &ldquo;No
              match&rdquo;, and it is decided again on the next session.
            </p>
          ) : null}
          {signalTable.status === "loading" ? (
            <SkeletonList rows={4} />
          ) : signalTable.status === "error" ? (
            <EmptyState
              variant="compact"
              testId="monitor-signals-error"
              title="Signals could not be loaded"
              actions={
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={signalTable.reload}
                >
                  Try again
                </button>
              }
            />
          ) : (
            <DataTable
              label="Signals"
              testId="monitor-signals"
              rowTestId="monitor-signal-row"
              columns={SIGNAL_COLUMNS}
              rows={signalTable.rows}
              getRowKey={(row) => row.id}
              emptyState={
                <EmptyState
                  variant="compact"
                  testId="monitor-signals-empty"
                  title={
                    stateView === "PENDING_TRIGGER"
                      ? "No setups are waiting for a trigger"
                      : "No signals yet"
                  }
                  body={
                    <p>
                      {view.securities.length === 0 ? (
                        <>
                          This monitor has no current members. Add stocks to{" "}
                          <Link
                            className={styles.inlineLink}
                            href={`/lists/${view.stockListId}`}
                          >
                            {view.stockListName}
                          </Link>{" "}
                          and the next evaluation will check them.
                        </>
                      ) : (
                        "One is recorded when a stock in this list matches a level of the strategy at a market close."
                      )}
                    </p>
                  }
                />
              }
            />
          )}
          {signalTable.hasMore ? (
            <div className={styles.more}>
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={signalTable.loadMore}
                disabled={signalTable.loadingMore}
                data-testid="monitor-signals-more"
              >
                {signalTable.loadingMore ? "Loading…" : "Show more signals"}
              </button>
            </div>
          ) : null}
          <DisclosureNote id="signals" className={styles.disclosure} />
        </SectionCard>
      </div>

      {dialog.kind === "edit" ? (
        <MonitorFormDialog
          mode="edit"
          monitor={view}
          onClose={closeDialog}
          onSaved={() => {
            closeDialog();
            // A rebind changes the whole evaluation table, so the page re-reads rather than
            // patching what it already had.
            setLocal(null);
            reload();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete monitor"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{view.name}</strong> and the signals it recorded?
              This cannot be undone. The strategy and stock list it watches are
              not affected.
            </p>
          }
          confirmLabel="Delete monitor"
          pendingLabel="Deleting…"
          onClose={closeDialog}
          onConfirm={async () => {
            await deleteMonitor(view.id);
            router.push("/monitors");
          }}
        />
      ) : null}
    </PageContainer>
  );
}
