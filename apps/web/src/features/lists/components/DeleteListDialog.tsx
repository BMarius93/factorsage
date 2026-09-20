"use client";

import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import styles from "./ListDetail.module.css";

/**
 * The one delete-list confirmation, used from the collection row and from the list page, so the
 * same action never asks two different questions (UI-058).
 */
export function DeleteListDialog({
  name,
  onConfirm,
  onClose,
}: {
  readonly name: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title="Delete list"
      body={
        <p className={styles.confirmBody}>
          Delete <strong>{name}</strong> and every stock&apos;s membership in
          it? This cannot be undone.
        </p>
      }
      confirmLabel="Delete list"
      pendingLabel="Deleting…"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
