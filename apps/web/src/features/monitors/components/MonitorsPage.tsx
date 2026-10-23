"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import {
  byName,
  byNewest,
  reversed,
  type CollectionSort,
} from "../../../components/ui/Collection";
import {
  IntermediateOnly,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { EntityReferenceChip } from "../../../components/ui/EntityReference";
import {
  CollectionSection,
  partitionByOwnership,
} from "../../../components/ui/OwnedCollection";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { SkeletonList } from "../../../components/ui/Skeleton";
import forms from "../../../components/ui/forms.module.css";
import { stockCountLabel } from "../../lists/utils/format";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { deleteMonitor } from "../api/monitors-api";
import { useMonitors } from "../hooks/use-monitors";
import { isBlockedByEntitlement } from "../utils/blocked-status";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { LimitMeter } from "../../../components/ui/LimitMeter";
import { useEntitlements } from "../../auth/hooks/use-entitlements";
import { PLAN_LABEL } from "../../billing/utils/format";
import { activeSignalLabel, lastScanLabel } from "../utils/format";
import { MonitorEnabledControl } from "./MonitorEnabledControl";
import { MonitorFormDialog } from "./MonitorFormDialog";
import styles from "./MonitorsPage.module.css";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; monitor: MonitorSummaryResponse }
  | { kind: "delete"; monitor: MonitorSummaryResponse };

const SIGN_IN_TO_CREATE = {
  title: "Sign in to create a monitor",
  body: "Built-in monitors are free to read. Your own monitors run against your strategies and lists, so creating one needs an account to own it.",
};

/** The Strategy and Stock list a monitor watches, as one folded line. */
function MonitorReferences({
  monitor,
}: {
  readonly monitor: MonitorSummaryResponse;
}) {
  return (
    <>
      <EntityReferenceChip
        kind="strategy"
        name={monitor.strategyName}
        href={`/strategies/${monitor.strategyId}`}
      />
      <EntityReferenceChip
        kind="list"
        name={monitor.stockListName}
        href={`/lists/${monitor.stockListId}`}
      />
      <span className={styles.listCount}>
        {stockCountLabel(monitor.securityCount)}
      </span>
    </>
  );
}

/**
 * What a plan limit has stopped, said once at the top of the page with a way forward (UI-021).
 *
 * A downgrade never deletes or switches anything off: an over-capacity account keeps its monitors
 * switched on and the system pauses the ones outside the allowance. The rows each say "Paused —
 * plan limit"; this says why, in numbers, and what to do.
 */
function MonitorComplianceNotice({
  own,
}: {
  readonly own: readonly MonitorSummaryResponse[];
}) {
  const plan = useEntitlements();
  const paused = own.filter(
    (monitor) => monitor.enabled && isBlockedByEntitlement(monitor),
  );
  if (paused.length === 0 || plan.status !== "ready") {
    return null;
  }
  const byCapacity = paused.some((m) => m.blockedReason !== "LIST_OVER_LIMIT");
  const byList = paused.some((m) => m.blockedReason === "LIST_OVER_LIMIT");
  const limit = plan.entitlements.monitors.maxActive;
  const planName = plan.plan ? PLAN_LABEL[plan.plan] : "Your plan";
  const switchedOn = own.filter((monitor) => monitor.enabled).length;
  return (
    <EntitlementNotice
      announce="status"
      testId="monitors-compliance-notice"
      title={`${paused.length} ${paused.length === 1 ? "monitor is" : "monitors are"} paused by your plan`}
      message={
        <>
          {byCapacity && limit !== null
            ? `${planName} allows ${limit} active monitor${limit === 1 ? "" : "s"} and ${switchedOn} are switched on, so the ones outside the allowance wait. Disable the monitors you do not need — the next one takes the free slot. `
            : null}
          {byList
            ? "A monitor whose stock list holds more stocks than your plan allows waits until the list is smaller. Nothing was deleted or switched off."
            : "Nothing was deleted or switched off."}
        </>
      }
    />
  );
}

/**
 * The orders a customer's own monitors can be read in. "Newest" is creation order, the default on
 * every management page; "Recently updated" is the last change. The Monitor and Active signals
 * headers sort too, each both ways. Search also matches the strategy and list a monitor watches,
 * since that is how people tell them apart.
 */
function bySignals(a: MonitorSummaryResponse, b: MonitorSummaryResponse) {
  return b.activeSignalCount - a.activeSignalCount;
}

const MONITOR_SORTS: readonly CollectionSort<MonitorSummaryResponse>[] = [
  {
    id: "newest",
    label: "Newest",
    compare: byNewest((monitor) => monitor.createdAt),
  },
  {
    id: "name",
    label: "Name A–Z",
    column: "monitor",
    direction: "asc",
    compare: byName,
  },
  {
    id: "name-desc",
    label: "Name Z–A",
    column: "monitor",
    direction: "desc",
    compare: reversed(byName),
  },
  {
    id: "signals",
    label: "Most active signals",
    column: "signals",
    direction: "desc",
    compare: bySignals,
  },
  {
    id: "signals-fewest",
    label: "Fewest active signals",
    column: "signals",
    direction: "asc",
    compare: reversed(bySignals),
  },
  {
    id: "updated",
    label: "Recently updated",
    compare: byNewest((monitor) => monitor.updatedAt),
  },
];

function monitorSearchText(monitor: MonitorSummaryResponse): string {
  return `${monitor.name} ${monitor.strategyName} ${monitor.stockListName}`;
}

/**
 * Monitors: the viewer's own, and FactorSage's built-in ones (`docs/decisions/monitor-eod-v2.md` §12).
 *
 * Two sections, one table shape: the same columns, typography, pills and switch, because the one
 * thing a viewer does with either is the same — enable it or disable it. What differs is behind the
 * switch: a customer's monitor has a lifecycle and a plan behind it, a built-in is shared platform
 * content evaluated once for everyone, and its switch is this viewer's own choice. A Guest reads the
 * built-in section and is asked for an account at the point of action.
 *
 * Everything a row shows comes from `GET /monitors`, which already carries the strategy and list
 * names, the universe size, the active-Signal count and the synchronization — so the collection is
 * one request rather than one per monitor, re-read while a monitor is catching up.
 */
export function MonitorsPage() {
  const { status, monitors, retry, applyCreated, applyUpdated, applyDeleted } =
    useMonitors();
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });
  const create = () =>
    gate.attempt(SIGN_IN_TO_CREATE, () => setDialog({ kind: "create" }));
  const { own, builtIn } = partitionByOwnership(monitors);

  const identityColumn: DataTableColumn<MonitorSummaryResponse> = {
    key: "monitor",
    header: "Monitor",
    cardRole: "identity",
    render: (monitor) => (
      <>
        <Link className={styles.nameLink} href={`/monitors/${monitor.id}`}>
          {monitor.name}
        </Link>
        {/* Between 880 and 1,279px the Strategy and Stock list columns fold in here, under the
            name, rather than squeezing three columns of chips until the actions scroll away. */}
        <IntermediateOnly testId="monitor-folded-relationships">
          <MonitorReferences monitor={monitor} />
        </IntermediateOnly>
      </>
    ),
  };

  // The one switch, on every row of both sections: a customer's own monitor's lifecycle, or this
  // viewer's own choice for a built-in. Notes under it say only what the switch cannot.
  const enabledColumn: DataTableColumn<MonitorSummaryResponse> = {
    key: "enabled",
    width: "13rem",
    header: "Enabled",
    cardRole: "status",
    cardLabel: "Enabled",
    render: (monitor) => (
      <MonitorEnabledControl
        monitor={monitor}
        gate={gate}
        onChanged={applyUpdated}
      />
    ),
  };

  const referenceColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    {
      key: "strategy",
      width: "13rem",
      header: "Strategy",
      cardRole: "links",
      foldIntermediate: true,
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
      width: "13rem",
      header: "Stock list",
      cardRole: "links",
      foldIntermediate: true,
      // The universe size belongs to the list, so it rides with the reference rather than
      // taking a column of its own — the row already carries as much as 1200px can hold.
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
      key: "signals",
      width: "9rem",
      header: "Active signals",
      // On a phone the signal count is the card's summary line; the last check keeps its label,
      // because a bare timestamp would not say what it is.
      cardRole: "summary",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (monitor) => (
        <span
          className={styles.signalCount}
          data-tone={monitor.activeSignalCount > 0 ? "active" : undefined}
        >
          {activeSignalLabel(monitor.activeSignalCount)}
        </span>
      ),
    },
    {
      key: "last-scan",
      width: "11rem",
      header: "Last checked",
      nowrap: true,
      render: (monitor) => lastScanLabel(monitor.lastScanAt),
    },
  ];

  // One column structure for both sections. The menu holds what is not the switch: Edit and Delete
  // on the viewer's own monitor; Edit on a built-in for an administrator, who changes it through the
  // very same editor; nothing for anybody else, since a built-in is never deleted. The column is
  // there for every signed-in viewer, so the two tables line up.
  const actionsColumn: DataTableColumn<MonitorSummaryResponse> = {
    key: "actions",
    width: "3.5rem",
    header: "Actions",
    cardRole: "menu",
    align: "right",
    nowrap: true,
    render: (monitor) =>
      monitor.ownership === "USER" ? (
        <OverflowMenu
          label={monitor.name}
          testId="monitor-actions"
          items={[
            {
              label: "Edit",
              onSelect: () => setDialog({ kind: "edit", monitor }),
            },
            {
              label: "Delete",
              tone: "danger",
              separated: true,
              onSelect: () => setDialog({ kind: "delete", monitor }),
            },
          ]}
        />
      ) : monitor.canEdit ? (
        <OverflowMenu
          label={monitor.name}
          testId="monitor-actions"
          items={[
            {
              label: "Edit",
              onSelect: () => setDialog({ kind: "edit", monitor }),
            },
          ]}
        />
      ) : null,
  };

  const columns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    identityColumn,
    enabledColumn,
    ...referenceColumns,
    ...(gate.signedIn ? [actionsColumn] : []),
  ];

  // How many of the viewer's own monitors are switched on, against the plan's allowance — shown
  // before anything is created or enabled (UI-020). Enabling is gated on this intent count.
  const plan = useEntitlements();
  const maxActive =
    plan.status === "ready" ? plan.entitlements.monitors.maxActive : null;
  const activeMeter =
    status === "ready" && gate.signedIn && plan.status === "ready" ? (
      <LimitMeter
        label="Active monitors"
        usage={own.filter((monitor) => monitor.enabled).length}
        limit={maxActive}
        unit={["active monitor", "active monitors"]}
        testId="monitors-active-meter"
      />
    ) : null;

  // "New monitor" lives in the header in every state (UI-030); it waits only for the session.
  const headerAction = (
    <button
      type="button"
      className={forms.tintedButton}
      data-testid="new-monitor-button"
      disabled={!gate.resolved}
      onClick={create}
    >
      New monitor
    </button>
  );

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitors-page">
        <PageHeader
          variant="plain"
          title="Monitors"
          lead="Watch a strategy over a stock list at every market close and collect the signals it produces."
          {...(activeMeter ? { aside: activeMeter } : {})}
          actions={headerAction}
        />

        {status === "ready" && gate.signedIn ? (
          <MonitorComplianceNotice own={own} />
        ) : null}

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading monitors">
            <SkeletonList rows={4} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="Your monitors could not be loaded"
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

        {status === "ready" && gate.signedIn ? (
          <CollectionSection
            density="compact"
            title="Your monitors"
            label="Your monitors"
            noun="monitors"
            testId="your-monitors"
            tableTestId="monitors-grid"
            rowTestId="monitor-card"
            footerTestId="monitors-footer"
            columns={columns}
            rows={own}
            getRowKey={(monitor) => monitor.id}
            searchText={monitorSearchText}
            sorts={MONITOR_SORTS}
            clickableRows
            emptyState={
              <EmptyState
                variant="compact"
                testId="monitors-empty"
                title="You haven't created any monitors yet"
                body={
                  <p>
                    A monitor watches one strategy over one stock list at every
                    market close, and records a signal whenever a stock matches
                    one of the strategy&apos;s levels. When you enable one, it
                    also evaluates the last 30 days, so its recent activity
                    appears on your dashboard. You choose what is watched and
                    whether it is enabled. Start with{" "}
                    <strong>New monitor</strong> above.
                  </p>
                }
              />
            }
          />
        ) : null}

        {status === "ready" && builtIn.length > 0 ? (
          <CollectionSection
            density="compact"
            title="Built-in monitors"
            caption="FactorSage's own monitors, evaluated once for everyone. Enable the ones whose activity you want on your dashboard; only FactorSage changes them."
            label="Built-in monitors"
            noun="monitors"
            testId="built-in-monitors"
            tableTestId="built-in-monitors-grid"
            rowTestId="monitor-card"
            footerTestId="built-in-monitors-footer"
            columns={columns}
            rows={builtIn}
            getRowKey={(monitor) => monitor.id}
            searchText={monitorSearchText}
            clickableRows
          />
        ) : null}
      </div>

      {gate.prompt}

      {dialog.kind === "create" ? (
        <MonitorFormDialog
          mode="create"
          activeCount={own.filter((monitor) => monitor.enabled).length}
          onClose={closeDialog}
          onSaved={(detail) => {
            applyCreated(detail);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "edit" ? (
        <MonitorFormDialog
          mode="edit"
          monitor={dialog.monitor}
          activeCount={own.filter((monitor) => monitor.enabled).length}
          onClose={closeDialog}
          onSaved={(summary) => {
            applyUpdated(summary);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete monitor"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{dialog.monitor.name}</strong> and the signals it
              recorded? This cannot be undone. The strategy and stock list it
              watches are not affected.
            </p>
          }
          confirmLabel="Delete monitor"
          pendingLabel="Deleting…"
          onClose={closeDialog}
          onConfirm={async () => {
            await deleteMonitor(dialog.monitor.id);
            applyDeleted(dialog.monitor.id);
            closeDialog();
          }}
        />
      ) : null}
    </PageContainer>
  );
}
