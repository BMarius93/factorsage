import type { ReactNode } from "react";
import styles from "./Notice.module.css";

export type NoticeTone = "info" | "warning" | "success" | "error";

type NoticeProps = {
  readonly tone?: NoticeTone;
  /** A short statement of what happened. Optional: a one-sentence notice needs only `children`. */
  readonly title?: ReactNode;
  /** The explanation: cause, consequence, what to do. */
  readonly children?: ReactNode;
  /** At most one or two next steps, using the shared `forms` button classes. */
  readonly actions?: ReactNode;
  /**
   * `alert` announces the notice the moment it appears — for an operational failure the user
   * must not miss. Everything else is static page content and announces nothing.
   */
  readonly announce?: "alert" | "status";
  readonly testId?: string;
};

/**
 * One inline message about the page's state: information, a warning, a success or an
 * operational failure (`docs/ui-audit/FACTOR_SAGE_UI_CLEANUP_PLAN.md` §3.7).
 *
 * It is not an empty state — `EmptyState` owns "nothing here", "not found" and "could not be
 * loaded" — and it is not a field error. It says something true about what the user is looking
 * at and, where there is one, offers the next step beside it. Tone is carried by a left rule and
 * a tint, never by colour alone: the title and copy say what happened.
 */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  announce,
  testId,
}: NoticeProps) {
  return (
    <div
      className={styles.notice}
      data-tone={tone}
      {...(announce ? { role: announce } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {title ? <p className={styles.title}>{title}</p> : null}
      {children ? <div className={styles.body}>{children}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
