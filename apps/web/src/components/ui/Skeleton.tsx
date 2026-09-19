import { PageHeader } from "./PageHeader";
import { SectionCard } from "./SectionCard";
import styles from "./Skeleton.module.css";

type SkeletonProps = {
  /** Height in CSS units; defaults to a single text line. */
  readonly height?: string;
  readonly width?: string;
  readonly radius?: "control" | "surface" | "card";
};

/** One shimmering placeholder block. */
export function Skeleton({ height, width, radius = "surface" }: SkeletonProps) {
  return (
    <span
      className={styles.block}
      data-radius={radius}
      style={{
        ...(height ? { height } : {}),
        ...(width ? { width } : {}),
      }}
    />
  );
}

type SkeletonListProps = {
  readonly rows?: number;
  /** Taller blocks for a collection of cards; shorter for table rows. */
  readonly rowHeight?: string;
};

/**
 * The loading shape of a collection.
 *
 * One skeleton language for every list in the product: five screens each drew their own grey
 * rectangles at different heights and radii before this existed. Always `aria-hidden` — a loading
 * placeholder is not content, and the surrounding region reports busy state instead.
 */
export function SkeletonList({ rows = 4, rowHeight = "64px" }: SkeletonListProps) {
  return (
    <div className={styles.list} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={rowHeight} />
      ))}
    </div>
  );
}

type DetailSkeletonProps = {
  /** What is loading, in words: "list", "strategy". Becomes the loading page's heading. */
  readonly thing: string;
  /** The collection the page belongs to — known before the entity is, so it is real at once. */
  readonly back: { readonly href: string; readonly label: string };
  readonly rows?: number;
};

/**
 * The loading shape of an entity page (UI-027): the real `PageHeader` frame with its back link, a
 * placeholder title and actions, and a section of rows — so nothing jumps when the entity lands.
 *
 * The page keeps exactly one `h1` while it loads ("Loading list…", read by assistive technology
 * only), and the region reports itself busy.
 */
export function DetailSkeleton({ thing, back, rows = 5 }: DetailSkeletonProps) {
  return (
    <div className={styles.detail} aria-busy="true" data-testid="detail-skeleton">
      <PageHeader
        back={back}
        title={
          <>
            <span className={styles.srOnly}>Loading {thing}…</span>
            <span className={styles.titleBar} aria-hidden="true">
              <Skeleton height="24px" width="min(16rem, 60vw)" />
            </span>
          </>
        }
        actions={
          <span className={styles.actionBars} aria-hidden="true">
            <Skeleton height="var(--button-height)" width="7.5rem" radius="control" />
            <Skeleton height="var(--button-height)" width="5rem" radius="control" />
          </span>
        }
      />
      <SectionCard ariaLabel={`Loading ${thing}`}>
        <SkeletonList rows={rows} />
      </SectionCard>
    </div>
  );
}
