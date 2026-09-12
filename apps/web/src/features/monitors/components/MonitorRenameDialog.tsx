"use client";

import {
  MONITOR_NAME_MAX_LENGTH,
  type MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { ApiError } from "../../../lib/api/client";
import { updateMonitor } from "../api/monitors-api";

type MonitorRenameDialogProps = {
  readonly monitor: Pick<
    MonitorSummaryResponse,
    "id" | "name" | "strategyName" | "stockListName"
  >;
  readonly onUpdated: (summary: MonitorSummaryResponse) => void;
  readonly onClose: () => void;
};

function requestMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return "The monitor could not be saved right now. Try again in a moment.";
}

/**
 * Renames a monitor.
 *
 * The name is the only editable identity a monitor has. Its strategy and its list are not editable
 * on purpose: the durable transition state that makes trigger semantics survive a restart is keyed
 * to a level of *this* strategy for a security of *this* list, so swapping either would silently
 * reinterpret a Signal history that recorded what was actually observed. Watching a different
 * pairing is a different monitor — create it, and delete this one.
 */
export function MonitorRenameDialog({
  monitor,
  onUpdated,
  onClose,
}: MonitorRenameDialogProps) {
  const [name, setName] = useState(monitor.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameMissing, setNameMissing] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setNameMissing(true);
      return;
    }

    setPending(true);
    setError(null);
    try {
      onUpdated(await updateMonitor(monitor.id, { name: trimmedName }));
    } catch (caught) {
      setError(requestMessage(caught));
      setPending(false);
    }
  };

  return (
    <Modal title="Edit monitor" onClose={onClose} testId="monitor-rename-dialog">
      <form className={forms.form} onSubmit={submit} noValidate>
        <div className={forms.field}>
          <label className={forms.label} htmlFor="monitor-rename-name">
            Name
          </label>
          <input
            id="monitor-rename-name"
            className={forms.input}
            type="text"
            value={name}
            maxLength={MONITOR_NAME_MAX_LENGTH}
            aria-invalid={nameMissing && name.trim() === ""}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {nameMissing && name.trim() === "" ? (
            <p className={forms.hint} role="alert">
              A monitor needs a name.
            </p>
          ) : (
            <p className={forms.hint}>
              This monitor watches {monitor.strategyName} over{" "}
              {monitor.stockListName}. To watch a different pairing, create a
              new monitor.
            </p>
          )}
        </div>

        {error ? (
          <p className={forms.error} role="alert">
            {error}
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
            disabled={pending}
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
