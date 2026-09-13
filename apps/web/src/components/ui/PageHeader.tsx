import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

type PageHeaderProps = {
  /** The page's one `<h1>`. */
  readonly title: ReactNode;
  /** One sentence explaining what the page is for. Optional on detail pages. */
  readonly lead?: ReactNode;
  /** Status pills or counts that belong to the title itself, rendered beside it. */
  readonly badges?: ReactNode;
  /** Primary/secondary actions for the whole page. */
  readonly actions?: ReactNode;
  /** Back link to the parent collection, rendered above the title. */
  readonly back?: { readonly href: string; readonly label: string };
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
  actions,
  back,
  testId,
}: PageHeaderProps) {
  return (
    <div
      className={styles.wrapper}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {back ? (
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link className={styles.backLink} href={back.href}>
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
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
    </div>
  );
}
