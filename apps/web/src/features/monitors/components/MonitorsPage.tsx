"use client";

import type { MonitorSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import forms from "../../../components/ui/forms.module.css";
import { stockCountLabel } from "../../lists/utils/format";
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

type MonitorCardProps = {
  readonly monitor: MonitorSummaryResponse;
  readonly onToggled: (summary: MonitorSummaryResponse) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
};

/**
 * One monitor row.
 *
 * The enable/disable request is owned here rather than by the page so a failure is reported on the
 * monitor it belongs to, and so one in-flight toggle cannot disable the buttons on every other card.
 */
function MonitorCard({
  monitor,
  onToggled,
  onEdit,
  onDelete,
}: MonitorCardProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (pending) {
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      // The row is replaced by the API's own answer, so a refused or partially applied change can
      // never leave the card claiming a state the server does not hold.
      onToggled(await updateMonitor(monitor.id, { enabled: !monitor.enabled }));
    } catch {
      setFailed(true);
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
    <li className={styles.card} data-testid="monitor-card">
      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <Link className={styles.cardName} href={`/monitors/${monitor.id}`}>
            {monitor.name}
          </Link>
          <span
            className={styles.statusPill}
            data-tone={monitor.enabled ? "positive" : "pending"}
          >
            {monitor.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Strategy</dt>
            <dd className={styles.factValue}>
              <Link
                className={styles.factLink}
                href={`/strategies/${monitor.strategyId}`}
              >
                {monitor.strategyName}
              </Link>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Stock list</dt>
            <dd className={styles.factValue}>
              <Link
                className={styles.factLink}
                href={`/lists/${monitor.stockListId}`}
              >
                {monitor.stockListName}
              </Link>
              <span className={styles.factCount}>
                {stockCountLabel(monitor.securityCount)}
              </span>
            </dd>
          </div>
        </dl>

        <div className={styles.cardMeta}>
          <span
            className={styles.signalCount}
            data-tone={monitor.activeSignalCount > 0 ? "active" : undefined}
          >
            {activeSignalLabel(monitor.activeSignalCount)}
          </span>
          <span>{lastScanLabel(monitor.lastScanAt)}</span>
        </div>

        {failed ? (
          <p className={styles.cardError} role="alert">
            That change did not save. This monitor is still{" "}
            {monitor.enabled ? "enabled" : "disabled"}.
          </p>
        ) : null}
      </div>

      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.cardAction}
          data-testid="toggle-monitor"
          disabled={pending}
          onClick={toggle}
        >
          {toggleLabel}
        </button>
        <button type="button" className={styles.cardAction} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={styles.cardActionDanger}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
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
  const {
    status,
    monitors,
    retry,
    applyCreated,
    applyUpdated,
    applyDeleted,
  } = useMonitors();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitors-page">
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Monitors</h1>
            <p className={styles.lead}>
              Watch a strategy against current market data and collect the
              signals it produces.
            </p>
          </div>
          {status === "ready" && monitors.length > 0 ? (
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="new-monitor-button"
              onClick={() => setDialog({ kind: "create" })}
            >
              New monitor
            </button>
          ) : null}
        </header>

        {status === "loading" ? (
          <div className={styles.grid} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.skeletonCard} />
            ))}
          </div>
        ) : null}

        {status === "error" ? (
          <div className={styles.statusPanel} role="alert">
            <h2 className={styles.statusTitle}>
              Your monitors could not be loaded
            </h2>
            <p className={styles.statusBody}>
              This is usually temporary — try again in a moment.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        ) : null}

        {status === "ready" && monitors.length === 0 ? (
          <div className={styles.statusPanel} data-testid="monitors-empty">
            <h2 className={styles.statusTitle}>No monitors yet</h2>
            <p className={styles.statusBody}>
              A monitor watches one strategy over one stock list using current
              prices, and records a signal whenever a stock matches one of the
              strategy&apos;s levels. Scanning runs in the background on a fixed
              schedule, so there is nothing to time yourself — you choose what
              is watched and whether it is running.
            </p>
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="new-monitor-button"
              onClick={() => setDialog({ kind: "create" })}
            >
              Create your first monitor
            </button>
          </div>
        ) : null}

        {status === "ready" && monitors.length > 0 ? (
          <ul className={styles.grid} data-testid="monitors-grid">
            {monitors.map((monitor) => (
              <MonitorCard
                key={monitor.id}
                monitor={monitor}
                onToggled={applyUpdated}
                onEdit={() => setDialog({ kind: "edit", monitor })}
                onDelete={() => setDialog({ kind: "delete", monitor })}
              />
            ))}
          </ul>
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
