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
