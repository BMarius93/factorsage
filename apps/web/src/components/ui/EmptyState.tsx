import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

type EmptyStateProps = {
  /** Rendered as `<h2>` by default; detail routes that have no other heading pass `as="h1"`. */
  readonly title: ReactNode;
  readonly body?: ReactNode;
  /** Primary/secondary actions. Use the shared `forms` button classes. */
  readonly actions?: ReactNode;
  /**
   * `error` marks the panel as an alert and tints the heading, for "this could not be loaded".
   * `compact` is for an empty region inside a section that already has its own heading.
   */
  readonly variant?: "empty" | "error" | "compact";
  readonly as?: "h1" | "h2";
  readonly testId?: string;
};

/**
 * Every "nothing here yet", "not found" and "could not be loaded" panel in the product.
 *
 * Nine screens each had their own `statusPanel`/`statusTitle`/`statusBody` trio before this, which
 * is why an empty list and an empty monitor looked like they came from different applications. The
 * copy stays with the feature — only the panel is shared.
 */
export function EmptyState({
  title,
  body,
  actions,
  variant = "empty",
  as = "h2",
  testId,
}: EmptyStateProps) {
  const Heading = as;
  return (
    <div
      className={styles.panel}
      data-variant={variant}
      {...(variant === "error" ? { role: "alert" } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <Heading className={styles.title}>{title}</Heading>
      {body ? <div className={styles.body}>{body}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
