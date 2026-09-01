import styles from "./StockDetailsSkeleton.module.css";

/**
 * Loading placeholder shaped like the final Stock Details layout, so the page settles without a
 * jarring layout shift and the shell stays usable while the API responds.
 */
export function StockDetailsSkeleton() {
  return (
    <div className={styles.page} role="status" aria-label="Loading stock details">
      <div className={styles.header}>
        <div className={styles.identity}>
          <span className={`${styles.block} ${styles.titleBlock}`} />
          <span className={`${styles.block} ${styles.badgeBlock}`} />
        </div>
        <div className={styles.quote}>
          <span className={`${styles.block} ${styles.priceBlock}`} />
          <span className={`${styles.block} ${styles.captionBlock}`} />
        </div>
      </div>
      <div className={styles.card}>
        <span className={`${styles.block} ${styles.toolbarBlock}`} />
        <span className={`${styles.block} ${styles.chartBlock}`} />
      </div>
      <div className={styles.columns}>
        <div className={styles.card}>
          <span className={`${styles.block} ${styles.sectionTitleBlock}`} />
          <span className={`${styles.block} ${styles.contentBlock}`} />
        </div>
        <div className={styles.card}>
          <span className={`${styles.block} ${styles.sectionTitleBlock}`} />
          <span className={`${styles.block} ${styles.contentBlock}`} />
        </div>
      </div>
      <span className={styles.srOnly}>Loading stock details</span>
    </div>
  );
}
