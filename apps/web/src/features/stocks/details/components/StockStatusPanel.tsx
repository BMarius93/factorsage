import type { ReactNode } from "react";
import styles from "./StockStatusPanel.module.css";

type StockStatusPanelProps = {
  readonly title: string;
  readonly description: string;
  /** Action row: links back to safety or a retry control. */
  readonly children?: ReactNode;
};

/**
 * Shared full-page state panel for Stock Details (not found, transient failure). It renders inside
 * the application shell so navigation and search stay usable.
 */
export function StockStatusPanel({
  title,
  description,
  children,
}: StockStatusPanelProps) {
  return (
    <section className={styles.panel}>
      <p className={styles.brand}>FactorSage</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
      {children ? <div className={styles.actions}>{children}</div> : null}
    </section>
  );
}
