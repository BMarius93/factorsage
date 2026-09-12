"use client";

import type {
  MonitorDetailResponse,
  MonitorSecurityEvaluationResponse,
  MonitorSignalResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import forms from "../../../components/ui/forms.module.css";
import { stockCountLabel } from "../../lists/utils/format";
import { deleteMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitor } from "../hooks/use-monitor";
import {
  activeSignalLabel,
  formatMonitorTimestamp,
  formatObservationPrice,
  LEVEL_KIND_LABELS,
  NEVER_CHECKED_LABEL,
  SECURITY_STATUS_LABELS,
  SECURITY_STATUS_TONES,
  SIGNAL_KIND_LABELS,
} from "../utils/format";
import { MonitorFormDialog } from "./MonitorFormDialog";
import styles from "./MonitorDetail.module.css";

/** What the newest-first Signal window the API returns is capped at. */
const SIGNAL_WINDOW = 100;

type DialogState = { kind: "closed" } | { kind: "edit" } | { kind: "delete" };

function SecurityRow({
  entry,
}: {
  readonly entry: MonitorSecurityEvaluationResponse;
}) {
  // A price exists only where an active Signal recorded the observation it was decided on. There is
  // no stored price for a security that did not match, and inventing one would be fabrication.
  const price = entry.matchedLevels[0]?.observationPrice;
  return (
    <li className={styles.row} data-testid="monitor-security-row">
      <div className={styles.rowIdentity}>
        <Link
          className={styles.symbol}
          href={`/stocks/${encodeURIComponent(entry.security.symbol)}`}
        >
          {entry.security.symbol}
        </Link>
        <span className={styles.rowName}>{entry.security.name}</span>
      </div>
      <span
        className={styles.statusPill}
        data-tone={SECURITY_STATUS_TONES[entry.status]}
        data-testid="monitor-security-status"
      >
        {SECURITY_STATUS_LABELS[entry.status]}
      </span>
      <div className={styles.rowLevels}>
        {entry.matchedLevels.length === 0 ? (
          <span className={styles.placeholder}>—</span>
        ) : (
          entry.matchedLevels.map((level) => (
            <span
              key={level.levelId}
              className={styles.levelChip}
              data-kind={level.levelKind}
            >
              {LEVEL_KIND_LABELS[level.levelKind]} ·{" "}
              {SIGNAL_KIND_LABELS[level.kind]}
            </span>
          ))
        )}
      </div>
      <span className={styles.rowPrice}>
        {price === undefined ? (
          <span className={styles.placeholder}>—</span>
        ) : (
          formatObservationPrice(price)
        )}
      </span>
      <span className={styles.rowSince}>
        {entry.statusSince === undefined ? (
          <span className={styles.placeholder}>—</span>
        ) : (
          formatMonitorTimestamp(entry.statusSince)
        )}
      </span>
    </li>
  );
}

function SignalRow({ signal }: { readonly signal: MonitorSignalResponse }) {
  return (
    <li className={styles.row} data-testid="monitor-signal-row">
      <div className={styles.rowIdentity}>
        <Link
          className={styles.symbol}
          href={`/stocks/${encodeURIComponent(signal.security.symbol)}`}
        >
          {signal.security.symbol}
        </Link>
        <span className={styles.rowName}>{signal.security.name}</span>
      </div>
      <span className={styles.levelChip} data-kind={signal.levelKind}>
        {LEVEL_KIND_LABELS[signal.levelKind]} ·{" "}
        {SIGNAL_KIND_LABELS[signal.kind]}
      </span>
      <span className={styles.rowPrice}>
        {formatObservationPrice(signal.observationPrice)}
      </span>
      <span className={styles.rowSince}>
        {formatMonitorTimestamp(signal.detectedAt)}
      </span>
      <span
        className={styles.statusPill}
        data-tone={signal.resolvedAt === undefined ? "positive" : "pending"}
      >
        {signal.resolvedAt === undefined
          ? "Active"
          : `Ended ${formatMonitorTimestamp(signal.resolvedAt)}`}
      </span>
    </li>
  );
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
  const [toggleFailed, setToggleFailed] = useState(false);
  const [local, setLocal] = useState<MonitorSummaryResponse | null>(null);

  const closeDialog = () => setDialog({ kind: "closed" });

  if (status === "loading") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.skeleton} aria-hidden="true" />
          <div className={styles.skeletonPanel} aria-hidden="true" />
        </div>
      </PageContainer>
    );
  }

  if (status === "missing") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.statusPanel} data-testid="monitor-missing">
            <h1 className={styles.statusTitle}>This monitor no longer exists</h1>
            <p className={styles.statusBody}>
              It may have been deleted. Your other monitors are unaffected.
            </p>
            <Link className={styles.primaryLink} href="/monitors">
              Back to monitors
            </Link>
          </div>
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || monitor === null) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <div className={styles.statusPanel} role="alert">
            <h1 className={styles.statusTitle}>
              This monitor could not be loaded
            </h1>
            <p className={styles.statusBody}>
              This is usually temporary — try again in a moment.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={reload}
            >
              Try again
            </button>
          </div>
        </div>
      </PageContainer>
    );
  }

  // A toggle answers with the fresh summary, which is authoritative for the header while the
  // evaluation table below it is unchanged by enabling or disabling.
  const view: MonitorDetailResponse =
    local === null ? monitor : { ...monitor, ...local };

  const toggle = async () => {
    if (togglePending) {
      return;
    }
    setTogglePending(true);
    setToggleFailed(false);
    try {
      setLocal(await updateMonitor(view.id, { enabled: !view.enabled }));
    } catch {
      setToggleFailed(true);
    } finally {
      setTogglePending(false);
    }
  };

  const signalsAtWindow = view.signals.length >= SIGNAL_WINDOW;

  return (
    <PageContainer>
      <div className={styles.page} data-testid="monitor-detail">
        <div className={styles.breadcrumb}>
          <Link className={styles.backLink} href="/monitors">
            ← Monitors
          </Link>
        </div>

        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>{view.name}</h1>
            <span
              className={styles.statusPill}
              data-tone={view.enabled ? "positive" : "pending"}
              data-testid="monitor-enabled-pill"
            >
              {view.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="edit-monitor"
              onClick={() => setDialog({ kind: "edit" })}
            >
              Edit monitor
            </button>
            <button
              type="button"
              className={forms.secondaryButton}
              data-testid="toggle-monitor"
              disabled={togglePending}
              onClick={toggle}
            >
              {view.enabled
                ? togglePending
                  ? "Disabling…"
                  : "Disable"
                : togglePending
                  ? "Enabling…"
                  : "Enable"}
            </button>
            <button
              type="button"
              className={forms.dangerButton}
              data-testid="delete-monitor"
              onClick={() => setDialog({ kind: "delete" })}
            >
              Delete
            </button>
          </div>
        </header>

        {toggleFailed ? (
          <p className={forms.error} role="alert">
            That change did not save. This monitor is still{" "}
            {view.enabled ? "enabled" : "disabled"}.
          </p>
        ) : null}

        <section className={styles.factsCard} aria-label="Monitor configuration">
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Strategy</dt>
              <dd className={styles.factValue}>
                <Link
                  className={styles.factLink}
                  href={`/strategies/${view.strategyId}`}
                >
                  {view.strategyName}
                </Link>
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Stock list</dt>
              <dd className={styles.factValue}>
                <Link
                  className={styles.factLink}
                  href={`/lists/${view.stockListId}`}
                >
                  {view.stockListName}
                </Link>
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Stocks</dt>
              <dd className={styles.factValue}>
                {stockCountLabel(view.securityCount)}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Active signals</dt>
              <dd className={styles.factValue}>
                {activeSignalLabel(view.activeSignalCount)}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Last checked</dt>
              <dd className={styles.factValue} data-testid="monitor-last-checked">
                {view.lastScanAt === undefined
                  ? NEVER_CHECKED_LABEL
                  : formatMonitorTimestamp(view.lastScanAt)}
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.card} aria-labelledby="monitored-stocks-title">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="monitored-stocks-title">
              Monitored stocks
            </h2>
            <span className={styles.count}>{view.securities.length}</span>
          </div>
          {view.securities.length === 0 ? (
            <p className={styles.empty} data-testid="monitor-securities-empty">
              This monitor&apos;s stock list has no stocks yet. Add some to{" "}
              <Link className={styles.inlineLink} href={`/lists/${view.stockListId}`}>
                {view.stockListName}
              </Link>{" "}
              and the next scan will evaluate them.
            </p>
          ) : (
            <>
              <div className={styles.rowHeader} aria-hidden="true">
                <span>Stock</span>
                <span>Status</span>
                <span>Signal</span>
                <span>Price</span>
                <span>Status since</span>
              </div>
              <ul className={styles.list} data-testid="monitor-securities">
                {view.securities.map((entry) => (
                  <SecurityRow key={entry.security.id} entry={entry} />
                ))}
              </ul>
            </>
          )}
        </section>

        <section className={styles.card} aria-labelledby="recent-signals-title">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="recent-signals-title">
              Recent signals
            </h2>
            <span className={styles.count}>{view.signals.length}</span>
          </div>
          {view.signals.length === 0 ? (
            <p className={styles.empty} data-testid="monitor-signals-empty">
              No signals yet. One is recorded the moment a stock in this list
              matches a level of the strategy.
            </p>
          ) : (
            <>
              <div className={styles.rowHeader} aria-hidden="true">
                <span>Stock</span>
                <span>Level</span>
                <span>Price</span>
                <span>Detected</span>
                <span>State</span>
              </div>
              <ul className={styles.list} data-testid="monitor-signals">
                {view.signals.map((signal) => (
                  <SignalRow key={signal.id} signal={signal} />
                ))}
              </ul>
              {/* Honest about the window: the API returns the newest rows, not the lifetime. */}
              {signalsAtWindow ? (
                <p className={styles.note} data-testid="monitor-signals-window">
                  Showing the {SIGNAL_WINDOW} most recent signals. Older ones are
                  kept but are not listed here yet.
                </p>
              ) : null}
            </>
          )}
        </section>
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
