"use client";

import {
  MONITOR_NAME_MAX_LENGTH,
  type MonitorDetailResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { ApiError } from "../../../lib/api/client";
import { createMonitor } from "../api/monitors-api";
import { useMonitorOptions } from "../hooks/use-monitor-options";
import styles from "./CreateMonitorDialog.module.css";

type CreateMonitorDialogProps = {
  readonly onCreated: (detail: MonitorDetailResponse) => void;
  readonly onClose: () => void;
};

type FieldErrors = {
  readonly name?: string;
  readonly strategyId?: string;
  readonly stockListId?: string;
};

function requestMessage(error: unknown): string {
  // The API parses the same request again and rejects a reference that is not the caller's. When it
  // disagrees, its product-vocabulary message is what the user needs to read.
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return "The monitor could not be created right now. Try again in a moment.";
}

/**
 * Creates one monitor: a name, a live strategy, a live stock list, and whether it starts running.
 *
 * That is the whole model. There is deliberately no interval, no notification setting and no pinned
 * strategy version — `ai/product/monitors.md` keeps cadence an application decision, and monitoring
 * is live against the strategy's newest version by design. The API rejects an unknown field rather
 * than ignoring it, so a field invented here would fail loudly instead of silently doing nothing.
 */
export function CreateMonitorDialog({
  onCreated,
  onClose,
}: CreateMonitorDialogProps) {
  const { status, strategies, lists, retry } = useMonitorOptions();
  const [name, setName] = useState("");
  const [strategyId, setStrategyId] = useState("");
  const [stockListId, setStockListId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const missingStrategy = status === "ready" && strategies.length === 0;
  const missingList = status === "ready" && lists.length === 0;
  const blocked = missingStrategy || missingList;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) {
      return;
    }

    const trimmedName = name.trim();
    const found: FieldErrors = {
      ...(trimmedName === "" ? { name: "A monitor needs a name." } : {}),
      ...(strategyId === "" ? { strategyId: "Choose a strategy." } : {}),
      ...(stockListId === "" ? { stockListId: "Choose a stock list." } : {}),
    };
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) {
      return;
    }

    setPending(true);
    try {
      onCreated(
        await createMonitor({
          name: trimmedName,
          strategyId,
          stockListId,
          enabled,
        }),
      );
    } catch (caught) {
      setSubmitError(requestMessage(caught));
      setPending(false);
    }
  };

  return (
    <Modal title="New monitor" onClose={onClose} testId="create-monitor-dialog">
      {status === "loading" ? (
        <p className={styles.loading}>Loading your strategies and lists…</p>
      ) : null}

      {status === "error" ? (
        <div className={forms.form}>
          <p className={forms.error} role="alert">
            Your strategies and lists could not be loaded, so there is nothing
            to choose between yet. This is usually temporary.
          </p>
          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className={forms.primaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {/* A monitor is a strategy plus a list, so an empty picker would be a dead end. Say what is
          missing and link to where it is made instead. */}
      {blocked ? (
        <div className={forms.form} data-testid="monitor-prerequisites">
          <div className={styles.notice}>
            <p className={styles.noticeTitle}>
              A monitor watches one strategy over one stock list
            </p>
            <p className={styles.noticeBody}>
              {missingStrategy && missingList
                ? "You do not have a strategy or a stock list yet. Create both, then come back to start monitoring."
                : missingStrategy
                  ? "You have a stock list, but no strategy yet. Create the buy, sell and final-exit logic you want watched."
                  : "You have a strategy, but no stock list yet. Create the universe of stocks you want it watched against."}
            </p>
          </div>
          <div className={styles.noticeLinks}>
            {missingStrategy ? (
              <Link className={forms.primaryButton} href="/strategies/new">
                Create a strategy
              </Link>
            ) : null}
            {missingList ? (
              <Link
                className={
                  missingStrategy ? forms.secondaryButton : forms.primaryButton
                }
                href="/lists"
              >
                Create a stock list
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      {status === "ready" && !blocked ? (
        <form
          className={forms.form}
          onSubmit={submit}
          noValidate
          data-testid="create-monitor-form"
        >
          <div className={forms.field}>
            <label className={forms.label} htmlFor="monitor-name">
              Name
            </label>
            <input
              id="monitor-name"
              className={forms.input}
              type="text"
              value={name}
              maxLength={MONITOR_NAME_MAX_LENGTH}
              aria-invalid={errors.name !== undefined}
              placeholder="e.g. Value entries — core universe"
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
            />
            {errors.name ? (
              <p className={forms.hint} role="alert">
                {errors.name}
              </p>
            ) : null}
          </div>

          <div className={forms.field}>
            <label className={forms.label} htmlFor="monitor-strategy">
              Strategy
            </label>
            <select
              id="monitor-strategy"
              className={styles.select}
              data-testid="monitor-strategy"
              value={strategyId}
              aria-invalid={errors.strategyId !== undefined}
              onChange={(event) => {
                setStrategyId(event.target.value);
                setErrors((current) => ({ ...current, strategyId: undefined }));
              }}
            >
              <option value="">Select a strategy…</option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))}
            </select>
            {errors.strategyId ? (
              <p className={forms.hint} role="alert">
                {errors.strategyId}
              </p>
            ) : (
              <p className={forms.hint}>
                Monitoring is live: editing this strategy later changes what is
                being watched, without recreating the monitor.
              </p>
            )}
          </div>

          <div className={forms.field}>
            <label className={forms.label} htmlFor="monitor-list">
              Stock list
            </label>
            <select
              id="monitor-list"
              className={styles.select}
              data-testid="monitor-list"
              value={stockListId}
              aria-invalid={errors.stockListId !== undefined}
              onChange={(event) => {
                setStockListId(event.target.value);
                setErrors((current) => ({
                  ...current,
                  stockListId: undefined,
                }));
              }}
            >
              <option value="">Select a stock list…</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
            {errors.stockListId ? (
              <p className={forms.hint} role="alert">
                {errors.stockListId}
              </p>
            ) : (
              <p className={forms.hint}>
                Membership is read at the start of each scan, so adding or
                removing stocks takes effect on the next one.
              </p>
            )}
          </div>

          <div className={styles.checkRow}>
            <input
              id="monitor-enabled"
              className={styles.checkbox}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <label className={styles.checkLabel} htmlFor="monitor-enabled">
              Start monitoring now
              <span className={styles.checkHint}>
                Leave this off to save the monitor without evaluating it yet.
                You can enable it at any time.
              </span>
            </label>
          </div>

          {submitError ? (
            <p
              className={forms.error}
              role="alert"
              data-testid="create-monitor-error"
            >
              {submitError}
            </p>
          ) : null}

          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={forms.primaryButton}
              data-testid="submit-monitor"
              disabled={pending}
            >
              {pending ? "Creating…" : "Create monitor"}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
