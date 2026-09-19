"use client";

import {
  MONITOR_SECURITY_STATUSES,
  type MonitorDetailResponse,
  type MonitorSecurityEvaluationResponse,
  type MonitorSecurityStatus,
  type MonitorSignalResponse,
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
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import forms from "../../../components/ui/forms.module.css";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../../../components/ui/SegmentedControl";
import { formatDay, formatRelative } from "../../../lib/dates";
import { useNow } from "../../../lib/use-now";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { stockCountLabel } from "../../lists/utils/format";
import { deleteMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitor } from "../hooks/use-monitor";
import {
  blockedExplanation,
  isBlockedByEntitlement,
  MonitorStateBadge,
} from "../utils/blocked-status";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { RunBacktestLink } from "../../backtests/components/RunBacktestLink";
import {
  activeSignalLabel,
  formatMonitorTimestamp,
  formatObservationPrice,
  lastScanLabel,
  LEVEL_KIND_LABELS,
  RESOLUTION_REASON_LABELS,
  SECURITY_STATUS_LABELS,
  SECURITY_STATUS_ORDER,
  SECURITY_STATUS_TONES,
  SIGNAL_KIND_LABELS,
} from "../utils/format";
import { MonitorFormDialog } from "./MonitorFormDialog";
import styles from "./MonitorDetail.module.css";

/** What the newest-first Signal window the API returns is capped at. */
const SIGNAL_WINDOW = 100;

type DialogState = { kind: "closed" } | { kind: "edit" } | { kind: "delete" };

/** The BUY / SELL / FINAL EXIT tone, shared by the evaluation table and the Signal table. */
const LEVEL_TONES = {
  BUY: "positive",
  SELL: "negative",
  FINAL_EXIT: "warning",
} as const;

function LevelChip({
  levelKind,
  kind,
}: {
  readonly levelKind: MonitorSignalResponse["levelKind"];
  readonly kind: MonitorSignalResponse["kind"];
}) {
  return (
    <StatusBadge
      tone={LEVEL_TONES[levelKind]}
      variant="outline"
      dataAttributes={{ "data-kind": levelKind }}
    >
      {LEVEL_KIND_LABELS[levelKind]} · {SIGNAL_KIND_LABELS[kind]}
    </StatusBadge>
  );
}

function Placeholder() {
  return <span className={styles.placeholder}>—</span>;
}

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
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | MonitorSecurityStatus
  >("ALL");
  const now = useNow(30_000);

  const closeDialog = () => setDialog({ kind: "closed" });

  if (status === "loading") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <SectionCard ariaLabel="Loading monitor">
            <SkeletonList rows={5} />
          </SectionCard>
        </div>
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
            title="This monitor no longer exists"
            body={
              <p>
                It may have been deleted. Your other monitors are unaffected.
              </p>
            }
            actions={
              <Link className={forms.secondaryButton} href="/monitors">
                Back to monitors
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

  const signalsAtWindow = view.signals.length >= SIGNAL_WINDOW;

  // Matched first, then waiting, then undecided, no match and unchecked (UI-026).
  const sortedSecurities = [...view.securities].sort(
    (a, b) => SECURITY_STATUS_ORDER[a.status] - SECURITY_STATUS_ORDER[b.status],
  );
  const statusCounts = Object.fromEntries(
    MONITOR_SECURITY_STATUSES.map((status) => [
      status,
      view.securities.filter((entry) => entry.status === status).length,
    ]),
  ) as Record<MonitorSecurityStatus, number>;
  const statusFilterOptions: readonly SegmentedOption<
    "ALL" | MonitorSecurityStatus
  >[] = [
    { value: "ALL", label: "All", count: view.securities.length },
    ...MONITOR_SECURITY_STATUSES.filter(
      (status) => statusCounts[status] > 0,
    ).map((status) => ({
      value: status,
      label: SECURITY_STATUS_LABELS[status],
      count: statusCounts[status],
    })),
  ];
  // A refresh can empty the status being filtered on; the filter then falls back to All rather than
  // showing an empty table under a "no stocks" message that is not true.
  const activeStatusFilter =
    statusFilter !== "ALL" && (statusCounts[statusFilter] ?? 0) === 0
      ? "ALL"
      : statusFilter;
  const visibleSecurities =
    activeStatusFilter === "ALL"
      ? sortedSecurities
      : sortedSecurities.filter((entry) => entry.status === activeStatusFilter);

  const securityColumns: readonly DataTableColumn<MonitorSecurityEvaluationResponse>[] =
    [
      {
        key: "stock",
        header: "Stock",
        cardRole: "identity",
        render: (entry) => (
          <StockIdentity
            symbol={entry.security.symbol}
            name={entry.security.name}
            {...(entry.security.logoUrl
              ? { logoUrl: entry.security.logoUrl }
              : {})}
            href={`/stocks/${encodeURIComponent(entry.security.symbol)}`}
          />
        ),
      },
      {
        key: "status",
        header: "Status",
        cardRole: "status",
        nowrap: true,
        render: (entry) => (
          <StatusBadge
            tone={SECURITY_STATUS_TONES[entry.status]}
            testId="monitor-security-status"
          >
            {SECURITY_STATUS_LABELS[entry.status]}
          </StatusBadge>
        ),
      },
      {
        key: "levels",
        header: "Signal",
        nowrap: true,
        render: (entry) =>
          entry.matchedLevels.length === 0 &&
          entry.waitingLevels.length === 0 ? (
            <Placeholder />
          ) : (
            <span className={styles.levels}>
              {entry.matchedLevels.map((level) => (
                <LevelChip
                  key={level.levelId}
                  levelKind={level.levelKind}
                  kind={level.kind}
                />
              ))}
              {entry.waitingLevels.map((level) => (
                <StatusBadge
                  key={level.levelId}
                  tone="active"
                  variant="outline"
                  dataAttributes={{ "data-kind": level.levelKind }}
                >
                  {LEVEL_KIND_LABELS[level.levelKind]} · waiting for trigger
                </StatusBadge>
              ))}
            </span>
          ),
      },
      {
        key: "price",
        header: "Price",
        align: "right",
        numeric: true,
        nowrap: true,
        render: (entry) => {
          // A price exists only where an active Signal recorded the observation it was decided
          // on. There is no stored price for a security that did not match, and inventing one
          // would be fabrication.
          const price = entry.matchedLevels[0]?.observationPrice;
          return price === undefined ? (
            <Placeholder />
          ) : (
            formatObservationPrice(price)
          );
        },
      },
      {
        key: "since",
        header: "Status since",
        nowrap: true,
        render: (entry) =>
          entry.statusSince === undefined ? (
            <Placeholder />
          ) : (
            formatMonitorTimestamp(entry.statusSince)
          ),
      },
    ];

  const signalColumns: readonly DataTableColumn<MonitorSignalResponse>[] = [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      render: (signal) => (
        <StockIdentity
          symbol={signal.security.symbol}
          name={signal.security.name}
          {...(signal.security.logoUrl
            ? { logoUrl: signal.security.logoUrl }
            : {})}
          href={`/stocks/${encodeURIComponent(signal.security.symbol)}`}
        />
      ),
    },
    {
      key: "state",
      header: "State",
      cardRole: "status",
      nowrap: true,
      render: (signal) =>
        signal.resolvedAt === undefined ? (
          <StatusBadge tone="positive">Active</StatusBadge>
        ) : (
          // Ended, when, and why — the reason is text, not a hover (UI-026).
          <span className={styles.ended} data-testid="monitor-signal-ended">
            <StatusBadge tone="pending">Ended</StatusBadge>
            <span className={styles.endedDetail}>
              {formatMonitorTimestamp(signal.resolvedAt)}
              {signal.resolutionReason &&
              RESOLUTION_REASON_LABELS[signal.resolutionReason] !== "ended"
                ? ` · ${RESOLUTION_REASON_LABELS[signal.resolutionReason]}`
                : ""}
            </span>
          </span>
        ),
    },
    {
      key: "level",
      header: "Level",
      nowrap: true,
      render: (signal) => (
        <LevelChip levelKind={signal.levelKind} kind={signal.kind} />
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (signal) => formatObservationPrice(signal.observationPrice),
    },
    {
      key: "detected",
      header: "Detected",
      nowrap: true,
      // One date format either way (UI-049): a session day for a reconstructed signal, a moment
      // for one observed live.
      render: (signal) =>
        signal.reconstructed
          ? `${formatDay(signal.observationDate)} · from history`
          : formatMonitorTimestamp(signal.detectedAt),
    },
  ];

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
          caption="A monitor is one strategy, watched over one stock list, against current market data."
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
          id="monitored-stocks"
          title="Monitored stocks"
          aside={`${view.securities.length}`}
          flush={view.securities.length > 0}
          {...(view.securities.length > 0
            ? {
                toolbar: (
                  <SegmentedControl
                    label="Filter by status"
                    testId="monitor-status-filter"
                    value={activeStatusFilter}
                    onChange={setStatusFilter}
                    options={statusFilterOptions}
                  />
                ),
              }
            : {})}
        >
          {statusCounts.NOT_EVALUABLE > 0 ? (
            // What "Not evaluable" means, once, in words (UI-026). The per-stock cause is not
            // recorded yet — see ui-system.md, known read-model gaps.
            <p
              className={styles.sectionNote}
              data-testid="monitor-not-evaluable-note"
            >
              <strong>Not evaluable</strong> means the last check could not
              decide the rule for that stock — for example its price history is
              too short for a metric, a value such as intrinsic value is not
              available, or no current quote arrived. It is not the same as
              &ldquo;No match&rdquo;, and it is checked again on the next scan.
            </p>
          ) : null}
          <DataTable
            label="Monitored stocks"
            testId="monitor-securities"
            rowTestId="monitor-security-row"
            columns={securityColumns}
            rows={visibleSecurities}
            getRowKey={(entry) => entry.security.id}
            emptyState={
              <EmptyState
                variant="compact"
                testId="monitor-securities-empty"
                title="No stocks to evaluate"
                body={
                  <p>
                    This monitor&apos;s stock list has no stocks yet. Add some
                    to{" "}
                    <Link
                      className={styles.inlineLink}
                      href={`/lists/${view.stockListId}`}
                    >
                      {view.stockListName}
                    </Link>{" "}
                    and the next scan will evaluate them.
                  </p>
                }
              />
            }
          />
        </SectionCard>

        <SectionCard
          id="recent-signals"
          title="Recent signals"
          aside={`${view.signals.length}`}
          flush={view.signals.length > 0}
        >
          <DataTable
            label="Recent signals"
            testId="monitor-signals"
            rowTestId="monitor-signal-row"
            columns={signalColumns}
            rows={view.signals}
            getRowKey={(signal) => signal.id}
            emptyState={
              <EmptyState
                variant="compact"
                testId="monitor-signals-empty"
                title="No signals yet"
                body={
                  <p>
                    One is recorded the moment a stock in this list matches a
                    level of the strategy.
                  </p>
                }
              />
            }
          />
          {/* Honest about the window: the API returns the newest rows, not the lifetime. */}
          {signalsAtWindow ? (
            <p className={styles.note} data-testid="monitor-signals-window">
              Showing the {SIGNAL_WINDOW} most recent signals. Older ones are
              kept but are not listed here yet.
            </p>
          ) : null}
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
