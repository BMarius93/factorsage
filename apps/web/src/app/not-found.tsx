import Image from "next/image";
import Link from "next/link";
import { BRAND_NAME } from "../components/layout/BrandMark";
import { EmptyState } from "../components/ui/EmptyState";
import forms from "../components/ui/forms.module.css";
import styles from "./not-found.module.css";

export const metadata = {
  title: "Page not found · FactorSage",
};

/**
 * Any URL no route matches (UX-006).
 *
 * Next renders this inside the root layout only — the product shell belongs to the `(app)` group
 * layout, which an unmatched URL never reaches — so it stands alone: the brand, one plain
 * sentence, and the way back. It reads the same for a Guest and a signed-in user, because it
 * needs no session to be useful.
 */
export default function NotFound() {
  return (
    <main className={styles.shell}>
      <Link
        href="/dashboard"
        className={styles.brandLink}
        aria-label={`${BRAND_NAME} home`}
      >
        <Image
          className={styles.wordmark}
          src="/images/logo/FactorSage-logo-transparent.png"
          alt=""
          width={846}
          height={146}
          priority
        />
      </Link>
      <div className={styles.panel}>
        <EmptyState
          as="h1"
          testId="not-found"
          title="This page does not exist"
          body={<p>The address may be mistyped, or the page may have moved.</p>}
          actions={
            <Link className={forms.primaryButton} href="/dashboard">
              Go to the Dashboard
            </Link>
          }
        />
      </div>
    </main>
  );
}
