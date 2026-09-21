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

/**
 * How tightly the header packs its three groups.
 *
 * `comfortable` — the default — is the page-opening header: the identity, the lead and the
 * actions separated across the full width. `compact` is the quote-header density: identity,
 * fact and action read as one dense row, and the surface keeps only the padding that row
 * needs. It exists for a readout the user came to compare against what sits below it, where
 * an airy header is height taken from the content.
 */
export type PageHeaderDensity = "comfortable" | "compact";

type PageHeaderProps = {
  /** The page's one `<h1>`. */
  readonly title: ReactNode;
  /** One sentence explaining what the page is for. Optional on detail pages. */
  readonly lead?: ReactNode;
  /** Status pills or counts that belong to the title itself, rendered beside it. */
  readonly badges?: ReactNode;
  /**
   * An identity mark for the entity — a company logo. It hangs beside the whole identity
   * block rather than inside the heading, so the title and the metadata under it read as one
   * identity however they wrap. Decoration: the header is unchanged without one.
   */
  readonly mark?: ReactNode;
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
  /** How tightly the identity, the fact and the actions are packed. */
  readonly density?: PageHeaderDensity;
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
  mark,
  aside,
  actions,
  back,
  variant = "surface",
  density = "comfortable",
  testId,
}: PageHeaderProps) {
  return (
    <div
      className={styles.wrapper}
      data-variant={variant}
      data-density={density}
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
        {/* Without a mark this wrapper is `display: contents` — the identity stays the flex
            item it has always been, and no page that does not use one changes shape. */}
        <div
          className={styles.identityGroup}
          {...(mark ? { "data-mark": "true" } : {})}
        >
          {mark ? <div className={styles.mark}>{mark}</div> : null}
          <div className={styles.identity}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{title}</h1>
              {badges ? <div className={styles.badges}>{badges}</div> : null}
            </div>
            {lead ? <p className={styles.lead}>{lead}</p> : null}
          </div>
        </div>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
    </div>
  );
}
