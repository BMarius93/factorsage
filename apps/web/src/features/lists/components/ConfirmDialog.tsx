"use client";

import { useState, type ReactNode } from "react";
import forms from "./lists-forms.module.css";
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

/** Confirmation gate for destructive list actions (delete list, remove stock). */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pendingLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} testId="confirm-dialog">
      <div className={forms.form}>
        <div>{body}</div>
        {failed ? (
          <p className={forms.error} role="alert">
            That did not work. Check your connection and try again.
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
