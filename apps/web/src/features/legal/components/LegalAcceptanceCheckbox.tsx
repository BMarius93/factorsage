"use client";

import { legalDocument, REQUIRED_TERMS_VERSION } from "@intrinsic/contracts";
import Link from "next/link";
import styles from "./LegalAcceptanceCheckbox.module.css";

/**
 * The one Terms acceptance control in the product.
 *
 * Both places acceptance can be given — the email activation form and the Google onboarding
 * screen — render this, so the wording, the version shown and the links are identical and cannot
 * drift into two slightly different contracts.
 *
 * What it deliberately does:
 *
 * - starts **unchecked**, and is a controlled input whose parent never defaults it to `true`;
 * - names the **version** being accepted, so somebody reading the record later and somebody
 *   ticking the box are looking at the same thing;
 * - links the Terms and the Risk Disclosure, both of which are being accepted, and the Privacy
 *   Policy, which is being **shown** rather than accepted — and says so in those words, because a
 *   privacy notice bundled into a contractual acceptance is exactly the conflation the EDPB
 *   guidance is about;
 * - opens each document in a new tab, so reading one does not discard a half-completed form.
 */
export function LegalAcceptanceCheckbox({
  id,
  checked,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
}) {
  const terms = legalDocument("TERMS");

  return (
    <div className={styles.wrapper}>
      <div className={styles.row}>
        <input
          className={styles.checkbox}
          id={id}
          name={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          aria-describedby={`${id}-note`}
          data-testid="accept-terms-checkbox"
        />
        <label className={styles.label} htmlFor={id}>
          I have read and accept the{" "}
          <DocumentLink href="/terms">Terms of Service</DocumentLink> and the{" "}
          <DocumentLink href="/risk-disclosure">Risk Disclosure</DocumentLink>,
          which forms part of them.
        </label>
      </div>
      <p className={styles.note} id={`${id}-note`}>
        Version {REQUIRED_TERMS_VERSION}, effective {terms.effectiveDate}. Read
        our <DocumentLink href="/privacy">Privacy Policy</DocumentLink> to see
        how your personal data is used — it is information, not something you
        are agreeing to here. FactorSage sends no marketing email.
      </p>
    </div>
  );
}

/** A document link that opens beside the form rather than replacing it. */
function DocumentLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Link className={styles.link} href={href} target="_blank" rel="noreferrer">
      {children}
    </Link>
  );
}
