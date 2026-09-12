"use client";

import { useState, type ReactNode } from "react";
import { ApiError } from "../../lib/api/client";
import forms from "./forms.module.css";
import { Modal } from "./Modal";

type ConfirmDialogProps = {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  /** Runs the mutation; the dialog owns pending/error state so callers stay declarative. */
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
};

/**
 * A domain refusal is not a transient failure.
 *
 * Deleting a strategy or a stock list a monitor still references is refused with 409 and the
 * product's own explanation — "This strategy is used by a monitor. Delete the monitor first."
 * Reporting that as a connection problem would send the user to retry something that can never
 * succeed, so the API's message is shown when it has one.
 */
function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return error.message;
  }
  return "That did not work. Check your connection and try again.";
}

/** Confirmation gate for a destructive action: deleting a list, a strategy, or a member row. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pendingLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (caught) {
      setFailure(failureMessage(caught));
      setPending(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} testId="confirm-dialog">
      <div className={forms.form}>
        <div>{body}</div>
        {failure ? (
          <p className={forms.error} role="alert">
            {failure}
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
            type="button"
            className={forms.dangerButton}
            onClick={confirm}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
