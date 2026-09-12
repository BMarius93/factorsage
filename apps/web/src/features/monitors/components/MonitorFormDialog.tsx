"use client";

import {
  MONITOR_NAME_MAX_LENGTH,
  type MonitorDetailResponse,
  type MonitorSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { ApiError } from "../../../lib/api/client";
import { createMonitor, updateMonitor } from "../api/monitors-api";
import { useMonitorOptions } from "../hooks/use-monitor-options";
import styles from "./MonitorFormDialog.module.css";

type CreateProps = {
  readonly mode: "create";
  readonly onSaved: (detail: MonitorDetailResponse) => void;
  readonly onClose: () => void;
};

type EditProps = {
  readonly mode: "edit";
  readonly monitor: Pick<
    MonitorSummaryResponse,
    "id" | "name" | "enabled" | "strategyId" | "stockListId"
  >;
  readonly onSaved: (summary: MonitorSummaryResponse) => void;
  readonly onClose: () => void;
};

type MonitorFormDialogProps = CreateProps | EditProps;

type FieldErrors = {
  readonly name?: string;
  readonly strategyId?: string;
  readonly stockListId?: string;
};

function requestMessage(error: unknown, mode: "create" | "edit"): string {
  // The API parses the same request again and re-checks that both references are the caller's.
  // When it disagrees, its product-vocabulary message is what the user needs to read.
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return mode === "create"
    ? "The monitor could not be created right now. Try again in a moment."
    : "The monitor could not be saved right now. Try again in a moment.";
}

/**
 * Creates or edits one monitor: a name, a live Strategy, a live Stock List, and whether it runs.
 *
 * That is the whole model, and both modes edit all of it — there is deliberately no interval,
 * notification or pinned-version field, and the API rejects an unknown key rather than ignoring it.
 *
 * Choosing a different Strategy or Stock List **rebinds** the monitor, which is a different thing
 * from editing the rules or membership of the ones it already references: those are live and need
 * no request at all. The form says so, in one line, only when the selection has actually moved.
 */
export function MonitorFormDialog(props: MonitorFormDialogProps) {
  const editing = props.mode === "edit" ? props.monitor : null;
  const { status, strategies, lists, retry } = useMonitorOptions();
  const [name, setName] = useState(editing?.name ?? "");
  const [strategyId, setStrategyId] = useState(editing?.strategyId ?? "");
  const [stockListId, setStockListId] = useState(editing?.stockListId ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Only creation can be blocked: an existing monitor already references a strategy and a list, so
  // both collections are guaranteed non-empty by the monitor itself.
  const missingStrategy =
    props.mode === "create" && status === "ready" && strategies.length === 0;
  const missingList =
    props.mode === "create" && status === "ready" && lists.length === 0;
  const blocked = missingStrategy || missingList;

  const rebinding =
    editing !== null &&
    (strategyId !== editing.strategyId || stockListId !== editing.stockListId);

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
      if (props.mode === "create") {
        props.onSaved(
          await createMonitor({
            name: trimmedName,
            strategyId,
            stockListId,
            enabled,
          }),
        );
      } else {
        // Every field is sent, including references that did not move. The API compares values,
        // so resubmitting the same strategy and list is not a rebind and resets nothing.
        props.onSaved(
          await updateMonitor(props.monitor.id, {
            name: trimmedName,
            strategyId,
            stockListId,
            enabled,
          }),
        );
      }
    } catch (caught) {
      setSubmitError(requestMessage(caught, props.mode));
      setPending(false);
    }
  };

  return (
    <Modal
      title={props.mode === "create" ? "New monitor" : "Edit monitor"}
      onClose={props.onClose}
      testId="monitor-form-dialog"
    >
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
              onClick={props.onClose}
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
          data-testid="monitor-form"
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
                Monitoring is live: editing this strategy&apos;s rules later
                changes what is being watched, without any change here.
              </p>
            )}
            {/* Said once, here, where a strategy is chosen — never per security, Signal or level. */}
            <p className={forms.hint} data-testid="monitor-position-metric-note">
              Rules using Gain or Loss are not evaluated by monitors, because
              those need position and cost-basis data. They still work in
              backtests.
            </p>
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
              {props.mode === "create" ? "Start monitoring now" : "Enabled"}
              <span className={styles.checkHint}>
                {props.mode === "create"
                  ? "Leave this off to save the monitor without evaluating it yet. You can enable it at any time."
                  : "A disabled monitor keeps its signals and resumes from where it left off when you enable it again."}
              </span>
            </label>
          </div>

          {rebinding ? (
            <p className={styles.rebindNote} data-testid="monitor-rebind-note">
              Changing the strategy or stock list starts monitoring the new
              configuration from the next scan. Existing signal history is
              preserved, and signals from the old configuration are closed.
            </p>
          ) : null}

          {submitError ? (
            <p
              className={forms.error}
              role="alert"
              data-testid="monitor-form-error"
            >
              {submitError}
            </p>
          ) : null}

          <div className={forms.actions}>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={props.onClose}
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
              {props.mode === "create"
                ? pending
                  ? "Creating…"
                  : "Create monitor"
                : pending
                  ? "Saving…"
                  : "Save changes"}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
