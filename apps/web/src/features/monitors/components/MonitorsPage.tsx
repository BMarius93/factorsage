"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useRef, useState } from "react";
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

type ToggleState = {
  readonly pending: boolean;
  readonly failure: string | null;
};

const IDLE: ToggleState = { pending: false, failure: null };

/**
 * Enabling and disabling the viewer's own monitors, one monitor at a time.
 *
 * Each monitor's request is its own: a toggle in flight disables that monitor's action and no
 * other, and a failure is reported on the monitor it belongs to. The row is replaced by the API's
 * own answer, so a refused or partially applied change never leaves it claiming a state the server
 * does not hold.
 */
function useMonitorToggles(
  onToggled: (summary: MonitorSummaryResponse) => void,
) {
  const [states, setStates] = useState<Readonly<Record<string, ToggleState>>>(
    {},
  );
  // The guard is a ref, not state: a second press before the re-render must not start a second
  // request.
  const inFlight = useRef(new Set<string>());

  const set = (id: string, state: ToggleState) =>
    setStates((current) => ({ ...current, [id]: state }));

  const toggle = async (monitor: MonitorSummaryResponse) => {
    if (inFlight.current.has(monitor.id)) {
      return;
    }
    inFlight.current.add(monitor.id);
    set(monitor.id, { pending: true, failure: null });
    try {
      onToggled(await updateMonitor(monitor.id, { enabled: !monitor.enabled }));
      set(monitor.id, IDLE);
    } catch (error) {
      // Enabling one monitor too many is a plan limit, not a failed save. Saying "that change did
      // not save" would be true but useless; the API's own message names the limit and the count.
      set(monitor.id, {
        pending: false,
        failure: requestFailureMessage(
          error,
          `That change did not save. This monitor is still ${
            monitor.enabled ? "enabled" : "disabled"
          }.`,
        ),
      });
    } finally {
      inFlight.current.delete(monitor.id);
    }
  };

  return {
    stateOf: (id: string): ToggleState => states[id] ?? IDLE,
    toggle,
  };
}

function toggleLabel(monitor: MonitorSummaryResponse, pending: boolean) {
  if (monitor.enabled) {
    return pending ? "Disabling…" : "Disable";
  }
  return pending ? "Enabling…" : "Enable";
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

export function MonitorsPage() {
  const { status, monitors, retry, applyCreated, applyUpdated, applyDeleted } =
    useMonitors();
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });
  const create = () =>
    gate.attempt(SIGN_IN_TO_CREATE, () => setDialog({ kind: "create" }));
  const { own, builtIn } = partitionByOwnership(monitors);
  const toggles = useMonitorToggles(applyUpdated);

  const identityColumn: DataTableColumn<MonitorSummaryResponse> = {
    key: "monitor",
    header: "Monitor",
    cardRole: "identity",
    render: (monitor) => {
      const failure = toggles.stateOf(monitor.id).failure;
      return (
        <>
          <Link className={styles.nameLink} href={`/monitors/${monitor.id}`}>
            {monitor.name}
          </Link>
          {/* Between 880 and 1,279px the Strategy and Stock list columns fold in here, under the
              name, rather than squeezing three columns of chips until the actions scroll away. */}
          <IntermediateOnly testId="monitor-folded-relationships">
            <MonitorReferences monitor={monitor} />
          </IntermediateOnly>
          {/* A refused enable/disable, said on the monitor it belongs to, under its name, where a
              sentence has room at every width. */}
          {failure ? (
            <span
              className={styles.rowError}
              role="alert"
              data-testid="monitor-toggle-error"
            >
              {failure}
            </span>
          ) : null}
        </>
      );
    },
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

  const ownColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    identityColumn,
    {
      key: "state",
      width: "11rem",
      header: "State",
      cardRole: "status",
      render: (monitor) => (
        <span className={styles.stateCell}>
          {/* One effective state, with its reason as text (UI-021). */}
          <MonitorStateBadge monitor={monitor} showReason size="small" />
        </span>
      ),
    },
    ...referenceColumns,
    {
      // The row itself opens the monitor (its name is the link), so the cell holds only the menu.
      key: "actions",
      width: "3.5rem",
      header: "Actions",
      cardRole: "menu",
      align: "right",
      nowrap: true,
      render: (monitor) => {
        const { pending } = toggles.stateOf(monitor.id);
        return (
          <OverflowMenu
            label={monitor.name}
            testId="monitor-actions"
            items={[
              {
                label: toggleLabel(monitor, pending),
                disabled: pending,
                onSelect: () => void toggles.toggle(monitor),
                testId: "toggle-monitor",
              },
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
        );
      },
    },
  ];

  const builtInColumns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
    identityColumn,
    {
      key: "visibility",
      width: "11rem",
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
    // A built-in is read-only for everybody but an administrator, who edits it through the very
    // same editor rather than a parallel admin form. It is never deleted by anyone. The row itself
    // opens it, so the column exists only where there is a menu to hold.
    ...(builtIn.some((monitor) => monitor.canEdit)
      ? [
          {
            key: "actions",
            width: "3.5rem",
            header: "Actions",
            cardRole: "menu" as const,
            align: "right" as const,
            nowrap: true,
            render: (monitor: MonitorSummaryResponse) =>
              monitor.canEdit ? (
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
          },
        ]
      : []),
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
            columns={ownColumns}
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
                    A monitor watches one strategy over one stock list using
                    current prices, and records a signal whenever a stock
                    matches one of the strategy&apos;s levels. Scanning runs in
                    the background on a fixed schedule, so there is nothing to
                    time yourself — you choose what is watched and whether it is
                    running. Start with <strong>New monitor</strong> above.
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
