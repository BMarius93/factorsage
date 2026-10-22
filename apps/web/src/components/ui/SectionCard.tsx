import type { ReactNode } from "react";
import styles from "./SectionCard.module.css";

/**
 * How the section packs its heading.
 *
 * `comfortable` — the default — stacks the heading, the toolbar and the body. `compact` is the
 * Dashboard's heading: the title, its count and the section's controls on one row, the table
 * directly under it, and a surface that stays a surface on a phone, where its rows are stacked
 * inside it rather than drawn as one card each (`DataTable density="compact"`).
 */
export type SectionCardDensity = "comfortable" | "compact";

type SectionCardProps = {
  /** Section heading. Omit for a surface that is purely a container. */
  readonly title?: ReactNode;
  /** One line under the title explaining what the section shows. */
  readonly caption?: ReactNode;
  /** Count, filters or controls aligned to the right of the heading row. */
  readonly aside?: ReactNode;
  /**
   * How many records the section holds, shown quietly beside the title — "Your lists 12". Give it
   * words for assistive technology (a visually hidden noun), because a bare number after a heading
   * says nothing.
   */
  readonly count?: ReactNode;
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
  /**
   * Makes the body its own scroll region, named with this label, for a surface whose height its
   * parent bounds (the Dashboard's Market watch sidebar). The heading, aside and toolbar stay put
   * while the body scrolls. The region takes a tab stop so a keyboard can scroll it, and the page
   * takes over the wheel when it reaches either end, so it never traps either.
   */
  readonly scrollLabel?: string;
  readonly density?: SectionCardDensity;
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
 * record its own card there and the wrapper would only draw a box around a stack of boxes. A
 * `compact` one does not: its table stacks its rows inside it instead.
 */
export function SectionCard({
  title,
  caption,
  aside,
  count,
  toolbar,
  children,
  flush,
  hero,
  scrollLabel,
  density = "comfortable",
  id,
  testId,
  ariaLabel,
}: SectionCardProps) {
  const headingId = title && id ? `${id}-title` : undefined;
  const compact = density === "compact";
  // A compact section's controls share the heading's row; otherwise they take a row of their own.
  const headToolbar = compact ? toolbar : undefined;
  const bodyToolbar = compact ? undefined : toolbar;
  const hasCount = count !== undefined && count !== null;
  const heading = title ? (
    <h2 className={styles.title} id={headingId}>
      {title}
    </h2>
  ) : null;

  return (
    <section
      className={styles.card}
      data-flush={flush ? "true" : undefined}
      data-hero={hero ? "true" : undefined}
      data-density={compact ? "compact" : undefined}
      {...(headingId ? { "aria-labelledby": headingId } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {title || aside || hasCount || headToolbar ? (
        <div className={styles.head}>
          <div className={styles.heading}>
            {hasCount ? (
              <div className={styles.titleRow}>
                {heading}
                <span className={styles.count}>{count}</span>
              </div>
            ) : (
              heading
            )}
            {caption ? <p className={styles.caption}>{caption}</p> : null}
          </div>
          {headToolbar ? (
            <div className={styles.toolbar}>{headToolbar}</div>
          ) : null}
          {aside ? <div className={styles.aside}>{aside}</div> : null}
        </div>
      ) : null}
      {bodyToolbar ? <div className={styles.toolbar}>{bodyToolbar}</div> : null}
      <div
        className={styles.body}
        data-flush={flush ? "true" : undefined}
        {...(scrollLabel
          ? {
              "data-scroll": "true",
              role: "region",
              "aria-label": scrollLabel,
              tabIndex: 0,
            }
          : {})}
      >
        {children}
      </div>
    </section>
  );
}
