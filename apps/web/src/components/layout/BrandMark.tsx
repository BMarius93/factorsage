import Image from "next/image";
import styles from "./BrandMark.module.css";

export const BRAND_NAME = "FactorSage";

const COMPACT_LOGO_SRC = "/images/logo/FactorSage-favicon-512.png";
const FULL_LOGO_SRC = "/images/logo/FactorSage-logo-transparent.png";

/**
 * Responsive brand treatment using the original FactorSage assets: the compact
 * mark on small screens, the full wordmark once the topbar has room for it.
 * Both are decorative; the surrounding link carries the accessible name.
 */
export function BrandMark() {
  return (
    <span className={styles.brand}>
      <Image
        className={styles.mark}
        src={COMPACT_LOGO_SRC}
        alt=""
        width={512}
        height={512}
        priority
      />
      <Image
        className={styles.wordmark}
        src={FULL_LOGO_SRC}
        alt=""
        width={846}
        height={146}
        priority
      />
    </span>
  );
}
