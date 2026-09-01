"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Modal.module.css";

type ModalProps = {
  /** Accessible dialog title, rendered as the header. */
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  /** Wider layout for editors with multi-column rows. */
  readonly wide?: boolean;
};

/**
 * Feature-local modal over the native `<dialog>` element, which supplies the top layer, focus
 * containment, and Escape handling for free. Mount it only while open; it shows itself modally on
 * mount. Promote to `components/ui` once a second feature genuinely needs it.
 */
export function Modal({ title, onClose, children, testId, wide }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      data-wide={wide ? "true" : undefined}
      aria-label={title}
      {...(testId ? { "data-testid": testId } : {})}
      onCancel={(event) => {
        // Escape: route through the same close path as the buttons.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Only a click on the backdrop (the dialog element itself) closes; clicks inside land on
        // child elements.
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
