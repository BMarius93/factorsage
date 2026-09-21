"use client";

import { REQUIRED_TERMS_VERSION } from "@intrinsic/contracts";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { Notice } from "../../../components/ui/Notice";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import pageStyles from "../../../components/ui/page.module.css";
import { describeRequestError } from "../../auth/utils/auth-errors";
import { acceptLegalTerms } from "../api/legal-api";
import { LegalAcceptanceCheckbox } from "./LegalAcceptanceCheckbox";
import styles from "./AcceptTermsPanel.module.css";

export const TERMS_NOT_ACCEPTED_MESSAGE =
  "Tick the box to record your acceptance, or use one of the links below instead.";

/**
 * The acceptance screen an existing or newly-created account sees once.
 *
 * Two audiences reach it, and the copy has to be honest with both: somebody who has just created
 * an account with Google — for whom this is the normal last step of signing up — and somebody
 * whose account predates the requirement, for whom it is a migration notice.
 *
 * ## What it must not do
 *
 * It must not trap anyone. The panel is rendered **in place of** a product route, never over the
 * whole application: the topbar and its account menu stay available, and the links below lead to
 * cancelling a renewal, submitting a statutory withdrawal or a privacy request, and contacting
 * support — all of which are reachable on the server too, not merely linked here.
 *
 * It must not pretend a refusal is impossible. Declining is simply not ticking the box and
 * navigating somewhere else; there is no "decline" button that would imply an account was closed
 * or a subscription cancelled, because neither happens.
 *
 * It must not ask again once accepted. Acceptance is per required version, so this appears once
 * per material change — a typo fix or a Privacy Policy update does not move the required version
 * and does not bring this screen back.
 */
export function AcceptTermsPanel({
  onAccepted,
}: {
  readonly onAccepted: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A double click can reach the handler twice before the disabled button renders.
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) {
      return;
    }
    if (!accepted) {
      setError(TERMS_NOT_ACCEPTED_MESSAGE);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await acceptLegalTerms({ termsVersion: REQUIRED_TERMS_VERSION });
      // Re-reads the server's answer rather than assuming success, so the gate lifts on what the
      // server says is recorded.
      onAccepted();
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <PageContainer width="reading">
      <div className={pageStyles.stack}>
        <PageHeader
          title="Review and accept the Terms of Service"
          lead="One step, once. Your account and everything in it are untouched either way."
          variant="plain"
          testId="accept-terms"
        />

        <SectionCard>
          <Notice tone="info" title="Why you are seeing this">
            <p>
              FactorSage now records which version of its Terms of Service each
              account has accepted. Your account has not recorded an acceptance
              of the current version, so we are asking once.
            </p>
            <p>
              Nothing has been decided on your behalf and no existing account
              has been marked as having accepted anything.
            </p>
          </Notice>

          <form
            className={styles.form}
            onSubmit={handleSubmit}
            noValidate
            data-testid="accept-terms-form"
          >
            <LegalAcceptanceCheckbox
              id="accept-terms"
              checked={accepted}
              onChange={setAccepted}
              disabled={submitting}
            />

            {error ? (
              <p
                className={styles.error}
                role="alert"
                data-testid="accept-terms-error"
              >
                {error}
              </p>
            ) : null}

            <button
              className={styles.primaryButton}
              type="submit"
              disabled={submitting || !accepted}
              data-testid="accept-terms-submit"
            >
              {submitting ? "Recording…" : "Accept and continue"}
            </button>
          </form>
        </SectionCard>

        <SectionCard
          title="If you would rather not accept"
          caption="These stay open to you whether or not you accept. Nothing here needs your agreement first."
        >
          <ul
            className={styles.escapes}
            data-testid="accept-terms-alternatives"
          >
            <li>
              <Link className={styles.link} href="/billing">
                Manage or cancel your subscription
              </Link>{" "}
              — cancelling a renewal stops the next charge and normally leaves
              access in place until the end of the period you have paid for.
            </li>
            <li>
              <Link className={styles.link} href="/cancellation-and-refunds">
                Submit a withdrawal request or report a problem with the service
              </Link>{" "}
              — statutory rights and nonconformity claims are separate from
              cancelling a renewal, and from this page.
            </li>
            <li>
              <Link className={styles.link} href="/legal/requests">
                Make a privacy or data request
              </Link>{" "}
              — access, correction, erasure, portability and the rest.
            </li>
            <li>
              <Link className={styles.link} href="/contact">
                Contact support
              </Link>
              , or read the{" "}
              <Link className={styles.link} href="/terms">
                Terms
              </Link>
              ,{" "}
              <Link className={styles.link} href="/privacy">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link className={styles.link} href="/risk-disclosure">
                Risk Disclosure
              </Link>{" "}
              in full first.
            </li>
            <li>
              Signing out is always available from the account menu at the top
              of the page.
            </li>
          </ul>
        </SectionCard>
      </div>
    </PageContainer>
  );
}
