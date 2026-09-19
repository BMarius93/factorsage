"use client";

import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../../lib/api/client";
import { verifyEmail } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";
import { signInHref } from "../utils/guest-routes";
import { ResendVerificationForm } from "./ResendVerificationForm";
import {
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "./ResetPasswordForm";

type VerificationState = "form" | "verified" | "invalid";

/**
 * Completes verification for the link in the user's inbox **and sets the account's password**.
 *
 * Opening the link verifies nothing on its own: the address is verified only when the person
 * holding the link chooses the password the account will use (AUTH-002). Whoever registered the
 * address proved nothing about the mailbox, so the password typed at registration is never what
 * this activates. That also means a link scanner or preview that merely opens the page cannot
 * spend the token.
 *
 * The token is carried straight through to the API in a POST body and never interpreted here.
 */
export function VerifyEmailPanel({ token }: { readonly token: string | null }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<VerificationState>("form");
  // State updates are asynchronous, so a double click can land before `submitting` re-renders the
  // button disabled; the ref closes that window.
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || inFlight.current) {
      return;
    }

    // Client-side checks only catch what the user can fix without a round trip; the API applies
    // the same policy authoritatively.
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(PASSWORD_TOO_SHORT_MESSAGE);
      return;
    }
    if (password !== confirmPassword) {
      setError(PASSWORD_MISMATCH_MESSAGE);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await verifyEmail({ token, password });
      setState("verified");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        // Unknown, expired, used or superseded — the API does not say which, and neither do we.
        setState("invalid");
      } else {
        // Anything else left the link unspent (the redemption is one transaction), so the form
        // stays and the same link can simply be submitted again.
        setError(describeRequestError(caught));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (state === "verified") {
    return (
      <div data-testid="verify-success">
        <p className={styles.success} role="status">
          Your email address is verified and your password is set.
        </p>
        <p className={styles.footerNote}>
          <Link className={styles.link} href={signInHref()}>
            Continue to sign in
          </Link>
        </p>
      </div>
    );
  }

  if (!token || state === "invalid") {
    return (
      <div data-testid="verify-failure">
        <p className={styles.error} role="alert">
          {!token
            ? "This page needs a verification link. Open the most recent link from your inbox."
            : "This verification link is invalid, expired, or has already been used."}
        </p>
        <p className={styles.status}>
          Enter your email address and we will send a new link.
        </p>
        <div className={styles.inlineAction}>
          <ResendVerificationForm />
        </div>
        <p className={styles.footerNote}>
          <Link className={styles.link} href={signInHref()}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <p className={styles.status} data-testid="verify-intro">
        Choose the password you will use to sign in to FactorSage.
      </p>

      <form
        className={styles.form}
        onSubmit={handleSubmit}
        noValidate
        data-testid="verify-form"
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            New password
          </label>
          <input
            className={styles.input}
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
          />
          <p className={styles.hint}>
            At least {PASSWORD_MIN_LENGTH} characters.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="confirmPassword">
            Confirm password
          </label>
          <input
            className={styles.input}
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={submitting}
            required
          />
        </div>

        {error ? (
          <p className={styles.error} role="alert" data-testid="verify-error">
            {error}
          </p>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Verifying…" : "Verify and set password"}
        </button>
      </form>

      <p className={styles.footerNote}>
        Didn&apos;t create a FactorSage account? You can close this page;
        nothing is activated until a password is chosen here.
      </p>
    </>
  );
}
