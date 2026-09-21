import Link from "next/link";
import styles from "./EntityReference.module.css";

/**
 * The product's own entities, as the UI refers to them.
 *
 * `ai/product/product-overview.md` owns what these are and how they relate; this type only names
 * them so a reference to one is rendered the same way everywhere it appears.
 */
export type EntityKind =
  | "monitor"
  | "strategy"
  | "list"
  | "backtest"
  | "benchmark"
  | "stock";

type EntityReferenceChipProps = {
  readonly kind: EntityKind;
  readonly name: string;
  /**
   * Omit for an entity with no page of its own, or one that no longer exists — a Benchmark, or a
   * Strategy deleted after the Backtest that snapshotted it. The chip then renders as plain text
   * rather than a link that would 404.
   */
  readonly href?: string;
  readonly testId?: string;
};

/**
 * One clickable reference to another entity.
 *
 * A Monitor's Strategy, a Backtest's List, a Signal's Monitor: the same pill everywhere, so the
 * user learns once that a bordered pill is something they can open. Every feature used to style
 * its own inline link, which made a relationship look like emphasis rather than navigation.
 *
 * There is deliberately one treatment, not a quieter one for busy rows: the Dashboard, Monitors
 * and Backtests show the same Strategy, List or Monitor, and it has to look like the same thing
 * on each. The name sits centred on at most two lines and is clipped with an ellipsis past them.
 */
export function EntityReferenceChip({
  kind,
  name,
  href,
  testId,
}: EntityReferenceChipProps) {
  const attributes = {
    className: styles.chip,
    "data-kind": kind,
    // The whole name as a native tooltip, the product's tooltip pattern: the label clips after two
    // lines, so nothing may depend on the visible part.
    title: name,
    ...(testId ? { "data-testid": testId } : {}),
  } as const;

  if (!href) {
    return (
      <span {...attributes} data-static="true">
        <span className={styles.chipLabel}>{name}</span>
      </span>
    );
  }

  return (
    <Link {...attributes} href={href}>
      <span className={styles.chipLabel}>{name}</span>
    </Link>
  );
}

export type LinkedEntity = {
  /** Relationship name as the product says it: "Strategy", "Stock list", "Benchmark". */
  readonly label: string;
  readonly kind: EntityKind;
  readonly name: string;
  readonly href?: string;
};

type LinkedEntitiesProps = {
  readonly entities: readonly LinkedEntity[];
  readonly heading?: string;
  readonly testId?: string;
};

/**
 * The "Linked" block: which other entities this one points at.
 *
 * Carried over from the legacy mobile cards, where making the Monitor → Strategy → List chain
 * explicit is what taught the product model. Used on detail pages; inside a `DataTable` the same
 * shape comes from columns with `cardRole: "links"`, so a collection does not need this component.
 */
export function LinkedEntities({
  entities,
  heading = "Linked",
  testId,
}: LinkedEntitiesProps) {
  const visible = entities.filter((entity) => entity.name.trim().length > 0);
  if (visible.length === 0) {
    return null;
  }

  return (
    <div
      className={styles.linked}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <p className={styles.linkedHeading}>{heading}</p>
      <dl className={styles.linkedRows}>
        {visible.map((entity) => (
          <div key={entity.label} className={styles.linkedRow}>
            <dt className={styles.linkedLabel}>{entity.label}</dt>
            <dd className={styles.linkedValue}>
              <EntityReferenceChip
                kind={entity.kind}
                name={entity.name}
                {...(entity.href ? { href: entity.href } : {})}
              />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
