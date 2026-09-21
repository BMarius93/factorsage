import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND_NAME } from "../../../components/layout/BrandMark";
import { ConsentBanner } from "../../legal/consent/ConsentBanner";
import { SiteFooter } from "../../legal/components/SiteFooter";
import styles from "./AuthCard.module.css";

const HEADING_ID = "auth-card-heading";

type AuthCardProps = {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
};

/**
 * Centered single-column surface shared by every unauthenticated auth screen.
 *
 * It carries the same legal footer the application shell does. Auth screens sit outside that
 * shell, and they are exactly where the links usually go missing — which matters here more than
 * elsewhere, because this is the point at which somebody is about to enter a contract and needs
 * to be able to read it first.
 */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div className={styles.page}>
      <main className={styles.shell}>
        <section className={styles.panel} aria-labelledby={HEADING_ID}>
          <header className={styles.header}>
            <Link
              href="/"
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
            <h1 id={HEADING_ID} className={styles.title}>
              {title}
            </h1>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </header>

          {children}

          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
          </section>
      </main>
      <SiteFooter />
      <ConsentBanner />
    </div>
  );
}
