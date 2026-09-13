"use client";

import type {
  MonitorBlockedReason,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import actionStyles from "../../../components/ui/actions.module.css";
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
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { deleteMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitors } from "../hooks/use-monitors";
import { activeSignalLabel, lastScanLabel } from "../utils/format";
import { MonitorFormDialog } from "./MonitorFormDialog";
import styles from "./MonitorsPage.module.css";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; monitor: MonitorSummaryResponse }
  | { kind: "delete"; monitor: MonitorSummaryResponse };

/**
 * Why an enabled monitor is not scanning, in the user's own terms.
 *
 * Both reasons are things the user can act on, and they need different actions — one is fixed by
 * editing a list, the other by disabling a monitor or upgrading — so they are never collapsed into
 * one message.
 */
function blockedExplanation(reason: MonitorBlockedReason | undefined): string {
  if (reason === "LIST_OVER_LIMIT") {
    return "Its stock list holds more stocks than your plan allows, so it cannot scan until the list is smaller or your plan is larger.";
  }
  return "Your plan allows fewer active monitors than you have enabled, so this one is waiting for a slot.";
}

/**
 * The enable/disable control for one row.
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
        <button
          type="button"
          className={actionStyles.action}
          data-testid="toggle-monitor"
          disabled={pending}
          onClick={toggle}
        >
          {toggleLabel}
        </button>
        <button type="button" className={actionStyles.action} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={actionStyles.actionDanger}
          onClick={onDelete}
        >
          Delete
        </button>
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
 * The signed-in user's monitors: a live strategy watched over a live stock list against current
 * market data.
 *
 * Everything a row shows comes from `GET /monitors`, which already carries the strategy and list
 * names, the universe size and the active-Signal count — so the collection is one request rather
 * than one per monitor. A monitor's Signals are not presented here; that surface is its own slice.
 */
export function MonitorsPage() {
  const { status, monitors, retry, applyCreated, applyUpdated, applyDeleted } =
    useMonitors();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });

  const columns: readonly DataTableColumn<MonitorSummaryResponse>[] = [
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
      key: "state",
      header: "State",
      cardRole: "status",
      render: (monitor) => (
        <span className={styles.stateCell}>
          {/*
            Two different facts, deliberately shown as two pills. `enabled` is what the user asked
            for and never changes on its own; the operational status is what the system will
            actually do with that intent right now. A monitor left over capacity by a downgrade is
            still enabled — collapsing the two would either claim it is scanning when it is not, or
            claim the user turned it off when they did not.
          */}
          <StatusBadge
            tone={monitor.enabled ? "positive" : "pending"}
            testId="monitor-enabled-pill"
          >
            {monitor.enabled ? "Enabled" : "Disabled"}
          </StatusBadge>
          {monitor.operationalStatus === "BLOCKED_BY_ENTITLEMENT" ? (
            <StatusBadge
              tone="blocked"
              testId="monitor-blocked-pill"
              title={blockedExplanation(monitor.blockedReason)}
              {...(monitor.blockedReason
                ? {
                    dataAttributes: {
                      "data-blocked-reason": monitor.blockedReason,
                    },
                  }
                : {})}
            >
              Not scanning
            </StatusBadge>
          ) : null}
        </span>
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

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitors-page">
        <PageHeader
          title="Monitors"
          lead="Watch a strategy against current market data and collect the signals it produces."
          actions={
            status === "ready" && monitors.length > 0 ? (
              <button
                type="button"
                className={forms.primaryButton}
                data-testid="new-monitor-button"
                onClick={() => setDialog({ kind: "create" })}
              >
                New monitor
              </button>
            ) : null
          }
        />

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

        {status === "ready" && monitors.length === 0 ? (
          <EmptyState
            testId="monitors-empty"
            title="No monitors yet"
            body={
              <p>
                A monitor watches one strategy over one stock list using current
                prices, and records a signal whenever a stock matches one of the
                strategy&apos;s levels. Scanning runs in the background on a
                fixed schedule, so there is nothing to time yourself — you
                choose what is watched and whether it is running.
              </p>
            }
            actions={
              <button
                type="button"
                className={forms.primaryButton}
                data-testid="new-monitor-button"
                onClick={() => setDialog({ kind: "create" })}
              >
                Create your first monitor
              </button>
            }
          />
        ) : null}

        {status === "ready" && monitors.length > 0 ? (
          <SectionCard
            id="monitors"
            title="Your monitors"
            aside={`${monitors.length} ${
              monitors.length === 1 ? "monitor" : "monitors"
            }`}
            flush
          >
            <DataTable
              label="Monitors"
              testId="monitors-grid"
              rowTestId="monitor-card"
              columns={columns}
              rows={monitors}
              getRowKey={(monitor) => monitor.id}
              clickableRows
            />
          </SectionCard>
        ) : null}
      </div>

      {dialog.kind === "create" ? (
        <MonitorFormDialog
          mode="create"
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
