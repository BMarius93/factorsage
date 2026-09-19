"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./WorkflowFooter.module.css";

type WorkflowFooterProps = {
  /**
   * A concise description of what is about to happen — the configuration being submitted,
   * the save state of an editor. Optional, and never a count of credits.
   */
  readonly summary?: ReactNode;
  /**
   * Why the last submit did not go through — a refusal from the server, a plan limit. It is
   * rendered **in the footer itself**, so on a phone it appears in the sticky bar the user just
   * tapped instead of a screen-height below it (UI-005), and it is announced through a live region
   * that exists before the message does. Field-level validation stays beside each field.
   */
  readonly error?: ReactNode;
  readonly errorTestId?: string;
  /** Cancel first, then the primary action. The order is the contract. */
  readonly children: ReactNode;
  readonly testId?: string;
};

/**
 * The default create/edit action footer.
 *
 * An ordinary workflow ends the same way, in the same place, in the same order — and on a
 * phone the bar sticks above the bottom navigation so a long form's submit is always
 * reachable. Features own the labels and the behaviour; this owns where they sit.
 *
 * It models a workflow that ends in one decision: cancel, or commit. **Strategy Builder is
 * a deliberate exception** and keeps its own save bar, because that bar carries live save
 * status, dirty state, an issue count that doubles as the reveal-and-focus control for the
 * first invalid condition, and Discard changes. Do not fold it in here to make the
 * vocabulary look tidier — see `ai/architecture/ui-system.md`.
 */
export function WorkflowFooter({
  summary,
  error,
  errorTestId,
  children,
  testId,
}: WorkflowFooterProps) {
  const footerRef = useRef<HTMLDivElement>(null);
  const hasError = Boolean(error);

  useEffect(() => {
    // On a desktop the footer is not sticky, and the message it just gained can push it past the
    // bottom of the viewport. Bring the whole footer — message and buttons — into view, moving
    // the page only as far as needed.
    if (hasError) {
      footerRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [hasError, error]);

  return (
    <div
      ref={footerRef}
      className={styles.footer}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {/* Always mounted: a live region inserted together with its message is often not
          announced. It takes no space while it is empty. */}
      <div className={styles.error} aria-live="assertive" aria-atomic="true">
        {error ? (
          <p
            className={styles.errorMessage}
            {...(errorTestId ? { "data-testid": errorTestId } : {})}
          >
            {error}
          </p>
        ) : null}
      </div>
      {summary ? (
        <div className={styles.summary} aria-live="polite">
          {summary}
        </div>
      ) : null}
      <div className={styles.actions}>{children}</div>
    </div>
  );
}
