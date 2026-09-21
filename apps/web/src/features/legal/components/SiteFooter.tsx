"use client";

import {
  LEGAL_DISCLOSURES,
  OPTIONAL_STORAGE_EXISTS,
} from "@intrinsic/contracts";
import Link from "next/link";
import { ownerFact } from "../owner-facts";
import styles from "./SiteFooter.module.css";

/**
 * The one footer, on every surface.
 *
 * Rendered by `AppShell` for the product routes and by `AuthCard` for the sign-in screens, so a
 * visitor can always reach the legal documents — including from a page where the application
 * shell is absent, which is where a footer is usually forgotten.
 *
 * Three things it carries and why:
 *
 * - **the legal destinations**, one per subject, matching the canonical routes;
 * - **the operator's identity**, not only the product brand: a visitor is contracting with a
 *   legal entity, and the E-commerce Directive is about being able to find out which one. While
 *   the entity is unresolved it says so in place rather than quietly showing only "FactorSage";
 * - **the short standing disclosure**, from the one shared copy source, so the claim that this
 *   is research tooling rather than advice is present wherever the product is.
 *
 * **Storage settings** appears only while the product actually has optional storage to govern.
 * A control that adjusted nothing would be theatre.
 *
 * It is a client component only because the storage-settings link is conditional on a compile-time
 * constant and the operator fact is read from inlined configuration; it issues no request and
 * reads no session, so it renders identically for a Guest, an expired session and a signed-in
 * user.
 */
export function SiteFooter() {
  const entity = ownerFact("LEGAL_ENTITY_NAME");

  return (
    <footer className={styles.footer} data-testid="site-footer">
      <div className={styles.inner}>
        <nav className={styles.links} aria-label="Legal and policies">
          <Link className={styles.link} href="/terms">
            Terms
          </Link>
          <Link className={styles.link} href="/privacy">
            Privacy
          </Link>
          <Link className={styles.link} href="/cookies">
            Cookies
          </Link>
          <Link className={styles.link} href="/risk-disclosure">
            Risk disclosure
          </Link>
          <Link className={styles.link} href="/cancellation-and-refunds">
            Cancellation &amp; refunds
          </Link>
          <Link className={styles.link} href="/contact">
            Contact
          </Link>
          {OPTIONAL_STORAGE_EXISTS ? (
            <Link
              className={styles.link}
              href="/cookies#storage-settings"
              data-testid="footer-storage-settings"
            >
              Storage settings
            </Link>
          ) : null}
        </nav>

        <p className={styles.disclosure}>{LEGAL_DISCLOSURES.footer}</p>

        <p className={styles.operator} data-testid="footer-operator">
          {entity ? (
            <>FactorSage is operated by {entity}.</>
          ) : (
            <>
              FactorSage.{" "}
              <span className={styles.pending}>
                Operator details pending — see Contact.
              </span>
            </>
          )}
        </p>
      </div>
    </footer>
  );
}
