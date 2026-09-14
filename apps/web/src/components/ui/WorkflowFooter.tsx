import type { ReactNode } from "react";
import styles from "./WorkflowFooter.module.css";

type WorkflowFooterProps = {
  /**
   * A concise description of what is about to happen — the configuration being submitted,
   * the save state of an editor. Optional, and never a count of credits.
   */
  readonly summary?: ReactNode;
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
  children,
  testId,
}: WorkflowFooterProps) {
  return (
    <div
      className={styles.footer}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {summary ? (
        <div className={styles.summary} aria-live="polite">
          {summary}
        </div>
      ) : null}
      <div className={styles.actions}>{children}</div>
    </div>
  );
}
