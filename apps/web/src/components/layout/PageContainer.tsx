import type { ReactNode } from "react";
import styles from "./PageContainer.module.css";

/**
 * How wide the route's content is allowed to run.
 *
 * `data` is the default because most of the product is a collection, a chart or a dense
 * detail page, and those are worth the screen. `reading` is for editors, auth and any
 * prose surface, where a capped measure is the point.
 */
export type PageWidth = "data" | "reading";

type PageContainerProps = {
  readonly children: ReactNode;
  readonly width?: PageWidth;
};

/** Responsive width/padding wrapper for route content inside the app shell. */
export function PageContainer({
  children,
  width = "data",
}: PageContainerProps) {
  return (
    <div className={styles.container} data-width={width}>
      {children}
    </div>
  );
}
