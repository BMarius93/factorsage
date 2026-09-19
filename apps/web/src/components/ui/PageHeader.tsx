import Link from "next/link";
import { guardNavigation } from "../layout/unsaved-changes";
import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

/**
 * How the header is framed.
 *
 * `surface` — the default — is the white bordered card every collection and entity detail
 * opens with. `plain` is for editors, where the form surface below already supplies the
 * visual container and a second one would be a box inside a box. `hero` is for a
 * result-first screen, where the title is composed *into* the feature's own hero surface
 * and so brings only the display type, not a second frame.
 */
export type PageHeaderVariant = "surface" | "plain" | "hero";

type PageHeaderProps = {
  /** The page's one `<h1>`. */
  readonly title: ReactNode;
  /** One sentence explaining what the page is for. Optional on detail pages. */
  readonly lead?: ReactNode;
  /** Status pills or counts that belong to the title itself, rendered beside it. */
  readonly badges?: ReactNode;
  /**
   * A page-level *fact* aligned to the right of the identity — a quote, a progress
   * readout. Not an action: it sits where actions sit, but it is something the page
   * reports rather than something the user can do.
   */
  readonly aside?: ReactNode;
  /** Primary/secondary actions for the whole page. */
  readonly actions?: ReactNode;
  /** Back link to the parent collection, rendered above the title. */
  readonly back?: { readonly href: string; readonly label: string };
  readonly variant?: PageHeaderVariant;
  readonly testId?: string;
};

/**
 * The one page-title treatment in the product.
 *
 * Every route rendered its own `header`/`title`/`lead`/`breadcrumb` before this existed, which is
 * why title sizes, action placement and back-link wording had drifted apart per feature. A feature
 * that needs something extra passes it through `badges` or `actions` rather than rebuilding the
 * header.
 */
export function PageHeader({
  title,
  lead,
  badges,
  aside,
  actions,
  back,
  variant = "surface",
  testId,
}: PageHeaderProps) {
  return (
    <div
      className={styles.wrapper}
      data-variant={variant}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {back ? (
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link
            className={styles.backLink}
            href={back.href}
            // A back link leaves the page like the shell's navigation does, so a page with
            // unsaved work gets to ask first (UI-053).
            onNavigate={guardNavigation}
          >
            <span aria-hidden="true">←</span> {back.label}
          </Link>
        </nav>
      ) : null}
      <header className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{title}</h1>
            {badges ? <div className={styles.badges}>{badges}</div> : null}
          </div>
          {lead ? <p className={styles.lead}>{lead}</p> : null}
        </div>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
    </div>
  );
}
