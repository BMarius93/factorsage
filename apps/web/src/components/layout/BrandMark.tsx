import styles from "./BrandMark.module.css";

export const BRAND_NAME = "FactorSage";
const BRAND_INITIALS = "FS";

/**
 * Responsive brand treatment: the compact mark is always present, the wordmark
 * joins it once the topbar has room for it.
 */
export function BrandMark() {
  return (
    <span className={styles.brand}>
      <span className={styles.mark} aria-hidden="true">
        {BRAND_INITIALS}
      </span>
      <span className={styles.wordmark} aria-hidden="true">
        {BRAND_NAME}
      </span>
    </span>
  );
}
