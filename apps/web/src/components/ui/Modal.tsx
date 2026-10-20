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
 * Where focus lands when a dialog opens: an element marked `data-autofocus`, otherwise the first
 * form field, otherwise the first control of the body. Never the header's close button, which is
 * what the native dialog would pick by being first in document order — a form should open on its
 * first field, and a confirmation on its least drastic action, which the shared action order puts
 * first.
 */
const INITIAL_FOCUS_SELECTORS = [
  "[data-autofocus]",
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
];

/**
 * Shared modal over the native `<dialog>` element, which supplies the top layer, focus
 * containment, and Escape handling for free. Mount it only while open; it shows itself modally on
 * mount.
 *
 * Focus is the dialog's to manage at both ends (GL-2): it opens on the body's first field rather
 * than on the close button, and whichever way it closes — Escape, Cancel, the close button, the
 * backdrop or a completed action — focus goes back to the control that opened it. When that
 * control no longer exists (an overflow-menu item, a row the action removed) it goes to the page's
 * main content instead of being dropped on `<body>`.
 */
export function Modal({ title, onClose, children, testId, wide }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Read during the first render, before any child's `autoFocus` or effect can move focus into
  // the dialog: by the time an effect runs, the element that opened the dialog is no longer the
  // active one.
  const openerRef = useRef<Element | null | undefined>(undefined);
  if (openerRef.current === undefined && typeof document !== "undefined") {
    openerRef.current = document.activeElement;
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    focusInitialElement(bodyRef.current);
    const opener = openerRef.current ?? null;
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
      restoreFocus(opener, dialog);
    };
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
        {/* `display: contents`: the wrapper only scopes where initial focus may land, and leaves
            the children laid out as direct items of the content grid. */}
        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
      </div>
    </dialog>
  );
}

function focusInitialElement(body: HTMLElement | null) {
  if (!body) {
    return;
  }
  // A child that already placed focus inside the body (a deliberate `focus()` call) wins.
  if (body.contains(document.activeElement)) {
    return;
  }
  for (const selector of INITIAL_FOCUS_SELECTORS) {
    const target = body.querySelector<HTMLElement>(selector);
    if (target) {
      target.focus();
      return;
    }
  }
}

/**
 * Returns focus to the dialog's opener once the dialog is gone.
 *
 * Deferred by one frame so the close has finished re-rendering the page: an action that removes
 * the opener (deleting the row whose menu opened the dialog) has done so by then, and focus goes
 * to the main content instead of to an element about to disappear. It never takes focus from
 * something the user has already moved to.
 */
function restoreFocus(
  opener: Element | null,
  dialog: HTMLDialogElement | null,
) {
  const run = () => {
    const active = document.activeElement;
    const focusIsFree =
      active === null ||
      active === document.body ||
      !active.isConnected ||
      (dialog !== null && dialog.contains(active));
    if (!focusIsFree) {
      return;
    }
    if (
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.isConnected &&
      !opener.closest("dialog")
    ) {
      opener.focus({ preventScroll: true });
      return;
    }
    document.getElementById("main-content")?.focus({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run);
  } else {
    run();
  }
}
