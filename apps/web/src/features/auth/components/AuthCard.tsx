import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND_NAME } from "../../../components/layout/BrandMark";
import styles from "./AuthCard.module.css";

const HEADING_ID = "auth-card-heading";

type AuthCardProps = {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
};

/** Centered single-column surface shared by every unauthenticated auth screen. */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
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
  );
}
