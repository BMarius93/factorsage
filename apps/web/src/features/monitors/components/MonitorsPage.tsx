"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import actionStyles from "../../../components/ui/actions.module.css";
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
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { deleteMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitors } from "../hooks/use-monitors";
import {
  isBlockedByEntitlement,
  MonitorStateBadge,
} from "../utils/blocked-status";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { LimitMeter } from "../../../components/ui/LimitMeter";
import { useEntitlements } from "../../auth/hooks/use-entitlements";
import { PLAN_LABEL } from "../../billing/utils/format";
import { activeSignalLabel, lastScanLabel } from "../utils/format";
import { BuiltInMonitorVisibility } from "./BuiltInMonitorVisibility";
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

/**
 * The enable/disable control for one of the viewer's own monitors.
 *
 * The request is owned here rather than by the page so a failure is reported on the monitor it
 * belongs to, and so one in-flight toggle cannot disable the buttons on every other row.
 */
function MonitorRowActions({
  monitor,
  onToggled,
  onEdit,
  onDelete,
}: {
  readonly monitor: MonitorSummaryResponse;
  readonly onToggled: (summary: MonitorSummaryResponse) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      // The row is replaced by the API's own answer, so a refused or partially applied change can
      // never leave the row claiming a state the server does not hold.
      onToggled(await updateMonitor(monitor.id, { enabled: !monitor.enabled }));
    } catch (error) {
      // Enabling one monitor too many is a plan limit, not a failed save. Saying "that change did
      // not save" would be true but useless; the API's own message names the limit and the count.
      setFailure(
        requestFailureMessage(
          error,
          `That change did not save. This monitor is still ${
            monitor.enabled ? "enabled" : "disabled"
          }.`,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const toggleLabel = monitor.enabled
    ? pending
      ? "Disabling…"
      : "Disable"
    : pending
      ? "Enabling…"
      : "Enable";

  return (
    <span className={styles.rowActions}>
      <span className={actionStyles.group}>
        <Link
          className={actionStyles.action}
          href={`/monitors/${monitor.id}`}
          aria-label={`Open ${monitor.name}`}
        >
          Open
        </Link>
        <OverflowMenu
          label={monitor.name}
          testId="monitor-actions"
          items={[
            {
              label: toggleLabel,
              disabled: pending,
              onSelect: toggle,
              testId: "toggle-monitor",
            },
            { label: "Edit", onSelect: onEdit },
            {
              label: "Delete",
              tone: "danger",
              separated: true,
              onSelect: onDelete,
            },
          ]}
        />
      </span>
      {failure ? (
        <span
          className={styles.rowError}
          role="alert"
          data-testid="monitor-toggle-error"
        >
          {failure}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Monitors: the viewer's own live strategies, and FactorSage's built-in ones.
 *
 * Two sections rather than one mixed table. They are not the same object with a different owner:
 * a customer's monitor has an `enabled` lifecycle and a plan behind it, while a built-in is shared
 * platform content whose only per-viewer state is whether its signals reach that viewer's dashboard
 * — which is why that switch lives on this page rather than on the Dashboard, beside the monitor it
 * is a property of. A Guest reads the built-in section and is asked for an account at the point of
 * action.
 *
 * Everything a row shows comes from `GET /monitors`, which already carries the strategy and list
 * names, the universe size and the active-Signal count — so the collection is one request rather
 * than one per monitor. A monitor's Signals are not presented here; that surface is its own slice.
 */
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

  const referenceColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    {
      key: "strategy",
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
      header: "Active signals",
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
      header: "Last checked",
      nowrap: true,
      render: (monitor) => lastScanLabel(monitor.lastScanAt),
    },
  ];

  const ownColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    identityColumn,
    {
      key: "state",
      header: "State",
      cardRole: "status",
      render: (monitor) => (
        <span className={styles.stateCell}>
          {/* One effective state, with its reason as text (UI-021). */}
          <MonitorStateBadge monitor={monitor} showReason />
        </span>
      ),
    },
    ...referenceColumns,
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (monitor) => (
        <MonitorRowActions
          monitor={monitor}
          onToggled={applyUpdated}
          onEdit={() => setDialog({ kind: "edit", monitor })}
          onDelete={() => setDialog({ kind: "delete", monitor })}
        />
      ),
    },
  ];

  const builtInColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    identityColumn,
    {
      key: "visibility",
      header: "On my dashboard",
      cardRole: "status",
      cardLabel: "On my dashboard",
      nowrap: true,
      render: (monitor) => (
        <BuiltInMonitorVisibility
          monitor={monitor}
          gate={gate}
          onChanged={applyUpdated}
        />
      ),
    },
    ...referenceColumns,
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      // A built-in is read-only for everybody but an administrator, who edits it through the very
      // same editor rather than a parallel admin form. It is never deleted by anyone.
      render: (monitor) => (
        <span className={actionStyles.group}>
          <Link
            className={actionStyles.action}
            href={`/monitors/${monitor.id}`}
            aria-label={`Open ${monitor.name}`}
          >
            Open
          </Link>
          {monitor.canEdit ? (
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
          ) : null}
        </span>
      ),
    },
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

  // Exactly one "New monitor" affordance in every state: the header carries it once the viewer has
  // monitors of their own (or is a Guest, who will never have a "Your monitors" section), and the
  // empty section carries it otherwise.
  const headerAction =
    gate.resolved && status === "ready" && (gate.guest || own.length > 0) ? (
      <button
        type="button"
        className={forms.tintedButton}
        data-testid="new-monitor-button"
        onClick={create}
      >
        New monitor
      </button>
    ) : null;

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitors-page">
        <PageHeader
          title="Monitors"
          lead="Watch a strategy against current market data and collect the signals it produces."
          {...(activeMeter ? { aside: activeMeter } : {})}
          {...(headerAction ? { actions: headerAction } : {})}
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
            title="Your monitors"
            label="Your monitors"
            noun="monitors"
            testId="your-monitors"
            tableTestId="monitors-grid"
            rowTestId="monitor-card"
            footerTestId="monitors-footer"
            columns={ownColumns}
            rows={own}
            getRowKey={(monitor) => monitor.id}
            clickableRows
            emptyState={
              <EmptyState
                variant="compact"
                testId="monitors-empty"
                title="You haven't created any monitors yet"
                body={
                  <p>
                    A monitor watches one strategy over one stock list using
                    current prices, and records a signal whenever a stock
                    matches one of the strategy&apos;s levels. Scanning runs in
                    the background on a fixed schedule, so there is nothing to
                    time yourself — you choose what is watched and whether it is
                    running.
                  </p>
                }
                actions={
                  <button
                    type="button"
                    className={forms.primaryButton}
                    data-testid="new-monitor-button"
                    onClick={create}
                  >
                    New monitor
                  </button>
                }
              />
            }
          />
        ) : null}

        {status === "ready" && builtIn.length > 0 ? (
          <CollectionSection
            title="Built-in monitors"
            caption="FactorSage's own monitors. Choose which of them appear on your dashboard; they keep running either way, and only FactorSage changes them."
            label="Built-in monitors"
            noun="monitors"
            testId="built-in-monitors"
            tableTestId="built-in-monitors-grid"
            rowTestId="monitor-card"
            footerTestId="built-in-monitors-footer"
            columns={builtInColumns}
            rows={builtIn}
            getRowKey={(monitor) => monitor.id}
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
