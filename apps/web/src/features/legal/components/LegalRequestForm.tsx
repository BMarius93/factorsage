"use client";

import {
  LEGAL_REQUEST_DETAILS_MAX_LENGTH,
  type LegalRequestKind,
  type LegalRequestReceipt,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Notice } from "../../../components/ui/Notice";
import { SectionCard } from "../../../components/ui/SectionCard";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { describeRequestError } from "../../auth/utils/auth-errors";
import { signInHref } from "../../auth/utils/guest-routes";
import { submitLegalRequest } from "../api/legal-api";
import { ownerFact } from "../owner-facts";
import { LegalRequestReceiptPanel } from "./LegalRequestReceipt";
import styles from "./LegalRequestForm.module.css";

type Copy = {
  readonly title: string;
  readonly caption: string;
  readonly prompt: string;
  readonly placeholder: string;
  readonly submit: string;
  /** The confirmation step's heading, before anything is sent. */
  readonly reviewTitle: string;
};

/**
 * Per-kind wording. Kept apart on purpose: a withdrawal, a privacy request and a fault report
 * have different rules and different outcomes, and a single generic "contact us" form would
 * be exactly the conflation the specification warns about.
 */
const COPY: Record<LegalRequestKind, Copy> = {
  WITHDRAWAL: {
    title: "Withdraw from your contract",
    caption:
      "The statutory right of withdrawal, where it applies to you. This is not the same as cancelling a renewal.",
    prompt: "What you are withdrawing from, and anything we should know",
    placeholder:
      "For example: I am withdrawing from the subscription I started on …",
    submit: "Review withdrawal request",
    reviewTitle: "Check your withdrawal request before sending it",
  },
  PRIVACY_REQUEST: {
    title: "Privacy and data request",
    caption:
      "Access, correction, erasure, restriction, objection, portability, or withdrawing a consent.",
    prompt: "What you are asking for",
    placeholder:
      "For example: please send me a copy of the personal data you hold about my account.",
    submit: "Review privacy request",
    reviewTitle: "Check your privacy request before sending it",
  },
  NONCONFORMITY: {
    title: "Report a problem with the service",
    caption:
      "The service does not do what was agreed, or what the law requires of it. Separate from withdrawal, and it does not expire with a withdrawal period.",
    prompt: "What is wrong",
    placeholder:
      "For example: backtests have failed to complete since …, which the plan I bought includes.",
    submit: "Review report",
    reviewTitle: "Check your report before sending it",
  },
  SUPPORT: {
    title: "Contact support",
    caption: "Anything else, including a complaint.",
    prompt: "How can we help",
    placeholder: "Tell us what you need.",
    submit: "Review message",
    reviewTitle: "Check your message before sending it",
  },
};

/**
 * One request channel, with a review step and a durable receipt.
 *
 * ## The shape the consumer rules ask for
 *
 * A withdrawal function has to identify the contract, let the person review what they are about
 * to submit, confirm it, and give them an immediate durable receipt carrying the submission time
 * and the content. This form is that shape for every kind, because the same care is warranted
 * for a privacy request and there is no reason to build two.
 *
 * - **Identification** comes from the authenticated session. The account is the contract holder,
 *   and the request is bound to it server-side — there is no email field somebody could use to
 *   submit on another person's behalf.
 * - **Review** is a separate step showing exactly what will be sent.
 * - **The receipt** is the response, shown immediately and downloadable, and recoverable later
 *   from the account's own request list.
 *
 * ## What it deliberately does not claim
 *
 * Submitting is not deciding. The receipt says so in those words: it acknowledges receipt and is
 * not a statement that money has been returned, that data has been erased, or that a withdrawal
 * has been accepted. Nothing here calculates a refund, touches a subscription or deletes
 * anything, because the rules for doing so are outstanding owner and counsel decisions (`O7`,
 * `O2`) and software that guessed them would be asserting a legal outcome nobody has made.
 *
 * No email is sent either, because there is no approved monitored mailbox to send from. A
 * promised confirmation email that never arrives is worse than saying plainly that the receipt
 * on screen is the confirmation.
 */
export function LegalRequestForm({
  kind,
}: {
  readonly kind: LegalRequestKind;
}) {
  const copy = COPY[kind];
  const { state: session } = useAuthSession();
  const [details, setDetails] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<LegalRequestReceipt | null>(null);
  const inFlight = useRef(false);

  const supportContact = ownerFact("SUPPORT_CONTACT");

  if (receipt) {
    return (
      <LegalRequestReceiptPanel
        receipt={receipt}
        onSubmitAnother={() => {
          setReceipt(null);
          setDetails("");
          setReviewing(false);
        }}
      />
    );
  }

  // Identification is the session. Saying so — and offering the sign-in link — matters more than
  // usual here: losing a password must not be what stops somebody submitting in time.
  if (session.status !== "authenticated") {
    return (
      <SectionCard title={copy.title} caption={copy.caption}>
        <Notice tone="info" title="Sign in to submit this from your account">
          <p>
            Submitting from your account is how we identify you without asking
            for documents.
          </p>
          <p>
            If you cannot sign in, that must not stop you submitting in time:
            write to{" "}
            {supportContact ? (
              <strong>{supportContact}</strong>
            ) : (
              <span className={styles.pending}>
                the support address on the Contact page (pending — owner input
                O2)
              </span>
            )}{" "}
            instead, and your request counts from when you sent it.
          </p>
          <p>
            <Link
              className={styles.link}
              href={signInHref("/cancellation-and-refunds")}
            >
              Sign in
            </Link>{" "}
            ·{" "}
            <Link className={styles.link} href="/contact">
              Contact details
            </Link>
          </p>
        </Notice>
      </SectionCard>
    );
  }

  function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (details.trim().length === 0) {
      setError("Describe what you are asking for so it can be handled.");
      return;
    }
    setError(null);
    setReviewing(true);
  }

  async function handleConfirm() {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      setReceipt(await submitLegalRequest({ kind, details: details.trim() }));
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (reviewing) {
    return (
      <SectionCard title={copy.reviewTitle} caption={copy.caption}>
        <div className={styles.review} data-testid="legal-request-review">
          <dl className={styles.reviewFacts}>
            <div>
              <dt>Request</dt>
              <dd>{copy.title}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{session.user.email}</dd>
            </div>
          </dl>
          <p className={styles.reviewLabel}>What you are sending</p>
          <blockquote className={styles.quote}>{details.trim()}</blockquote>
          <p className={styles.note}>
            Sending this records your request and gives you a receipt with a
            reference and the time it was submitted. A receipt confirms that it
            arrived — it is not a decision on the request, and no money moves
            and nothing is deleted because you sent it.
          </p>

          {error ? (
            <p
              className={styles.error}
              role="alert"
              data-testid="legal-request-error"
            >
              {error}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => setReviewing(false)}
              disabled={submitting}
            >
              Back to edit
            </button>
            <button
              className={styles.primaryButton}
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              data-testid="legal-request-confirm"
            >
              {submitting ? "Sending…" : "Confirm and send"}
            </button>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={copy.title} caption={copy.caption}>
      <form
        className={styles.form}
        onSubmit={handleReview}
        noValidate
        data-testid={`legal-request-form-${kind.toLowerCase()}`}
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`legal-request-${kind}`}>
            {copy.prompt}
          </label>
          <textarea
            className={styles.textarea}
            id={`legal-request-${kind}`}
            name="details"
            rows={5}
            maxLength={LEGAL_REQUEST_DETAILS_MAX_LENGTH}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder={copy.placeholder}
            aria-describedby={`legal-request-${kind}-hint`}
            required
          />
          <p className={styles.hint} id={`legal-request-${kind}-hint`}>
            Submitted from {session.user.email}. You will see the next step
            before anything is sent.
          </p>
        </div>

        {error ? (
          <p
            className={styles.error}
            role="alert"
            data-testid="legal-request-error"
          >
            {error}
          </p>
        ) : null}

        <button className={styles.primaryButton} type="submit">
          {copy.submit}
        </button>
      </form>
    </SectionCard>
  );
}
