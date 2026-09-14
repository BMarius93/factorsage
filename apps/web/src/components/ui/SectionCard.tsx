import type { ReactNode } from "react";
import styles from "./SectionCard.module.css";

type SectionCardProps = {
  /** Section heading. Omit for a surface that is purely a container. */
  readonly title?: ReactNode;
  /** One line under the title explaining what the section shows. */
  readonly caption?: ReactNode;
  /** Count, filters or controls aligned to the right of the heading row. */
  readonly aside?: ReactNode;
  /** Controls that belong under the heading and above the body, such as filter pills. */
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
  /**
   * `flush` removes the body padding so a `DataTable` can run edge to edge inside the
   * surface — the table owns its own cell padding.
   */
  readonly flush?: boolean;
  /**
   * The outcome-hero treatment: the large radius and the one real elevation in the
   * product. Reserved for a result the user opened the page to see — today only the
   * backtest result. Do not reach for it to make a section look important.
   */
  readonly hero?: boolean;
  readonly id?: string;
  readonly testId?: string;
  readonly ariaLabel?: string;
};

/**
 * The one large surface the product composes pages from: rounded, bordered, flat, white.
 *
 * This is the "card" of FactorSage's card feel — a page-level or section-level surface holding a
 * heading and a dense collection, not one box per record. Do not nest a `SectionCard` inside
 * another; that is what produced the card-in-card stacks this replaced.
 *
 * A `flush` surface dissolves below the table/card switch, because `DataTable` already gives each
 * record its own card there and the wrapper would only draw a box around a stack of boxes.
 */
export function SectionCard({
  title,
  caption,
  aside,
  toolbar,
  children,
  flush,
  hero,
  id,
  testId,
  ariaLabel,
}: SectionCardProps) {
  const headingId = title && id ? `${id}-title` : undefined;

  return (
    <section
      className={styles.card}
      data-flush={flush ? "true" : undefined}
      data-hero={hero ? "true" : undefined}
      {...(headingId ? { "aria-labelledby": headingId } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {title || aside ? (
        <div className={styles.head}>
          <div className={styles.heading}>
            {title ? (
              <h2 className={styles.title} id={headingId}>
                {title}
              </h2>
            ) : null}
            {caption ? <p className={styles.caption}>{caption}</p> : null}
          </div>
          {aside ? <div className={styles.aside}>{aside}</div> : null}
        </div>
      ) : null}
      {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      <div className={styles.body} data-flush={flush ? "true" : undefined}>
        {children}
      </div>
    </section>
  );
}
