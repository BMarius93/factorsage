import type { ReactNode } from "react";
import styles from "./StatusBadge.module.css";

/**
 * The product's status vocabulary.
 *
 * These are the tones the features already used; they are collected here so one meaning cannot be
 * painted two ways. `blocked` shares the warning palette but stays a separate name because it is a
 * separate product fact — an entitlement is holding work back, not a data problem — and the two
 * must be free to diverge without a find-and-replace across features.
 */
export type StatusTone =
  /** Succeeded, matched, enabled, gaining. */
  | "positive"
  /** Failed, exited, losing. */
  | "negative"
  /** Decided, but the answer needs attention: not evaluable, over limit. */
  | "warning"
  /** Decided and unremarkable. */
  | "neutral"
  /** Nothing has happened yet: queued, never checked, disabled. */
  | "pending"
  /** In flight or currently live. */
  | "active"
  /** Enabled, but an entitlement is preventing execution. */
  | "blocked";

type StatusBadgeProps = {
  readonly tone: StatusTone;
  readonly children: ReactNode;
  /** Longer explanation surfaced as a native tooltip. */
  readonly title?: string;
  /** `outline` reads as a quieter label inside dense tables. */
  readonly variant?: "solid" | "outline";
  readonly testId?: string;
  /** Extra data attributes so tests can assert on the raw domain value, not on prose. */
  readonly dataAttributes?: Readonly<Record<string, string | undefined>>;
};

/**
 * One pill for every status in the product: monitor state, signal level, run status, buy window.
 *
 * Features keep owning what a status *means* — the label and the tone come from the feature's own
 * canonical map — and this owns only how a status looks.
 */
export function StatusBadge({
  tone,
  children,
  title,
  variant = "solid",
  testId,
  dataAttributes,
}: StatusBadgeProps) {
  return (
    <span
      className={styles.badge}
      data-tone={tone}
      data-variant={variant}
      {...(title ? { title } : {})}
      {...(testId ? { "data-testid": testId } : {})}
      {...(dataAttributes ?? {})}
    >
      {children}
    </span>
  );
}
