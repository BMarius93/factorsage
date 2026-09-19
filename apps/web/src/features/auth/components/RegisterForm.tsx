"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { register } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import { signInHref } from "../utils/guest-routes";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "../utils/return-path";
import styles from "./auth-form.module.css";
import { GoogleSignInButton } from "./GoogleSignInButton";

/**
 * Deliberately neutral, and shown for every accepted request (AUTH-003).
 *
 * The API answers identically whether the address is new, already registered, signed in with
 * Google, or was submitted a moment ago, and it may send nothing at all. So the copy promises
 * neither that an account was created nor that an email is on its way — otherwise the UI would
 * leak exactly what the endpoint refuses to.
 */
export const REGISTRATION_ACCEPTED_MESSAGE =
  "If this address can be used, you'll receive an email with the next step.";

/**
 * Email-first registration: the address is the whole form (AUTH-003).
 *
 * No password is asked for here. The activation email's link opens `/verify-email`, where the
 * person who actually holds the mailbox chooses the password the account will use.
 *
 * `returnPath` is only carried on the links back to sign-in and to Google, so a visitor who signs
 * in from here in the same tab still returns to where they started. It is deliberately **not**
 * put into the activation email: verification activates an account and nothing else.
 */
export function RegisterForm({
  returnPath = DEFAULT_RETURN_PATH,
}: {
  readonly returnPath?: string;
} = {}) {
  const destination = safeReturnPath(returnPath);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  // State updates are asynchronous, so a fast double click can reach the handler twice before
  // the disabled button renders; the ref closes that gap.
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await register({ email });
      setAccepted(true);
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (accepted) {
    return (
      <div data-testid="register-accepted">
        <p className={styles.success} role="status">
          {REGISTRATION_ACCEPTED_MESSAGE}
        </p>
        <p className={styles.status}>
          The link in that email lets you choose your password. It can take a
          few minutes to arrive, so check your spam folder too. Nothing arrived?
          You can ask again from this page a little later.
        </p>
        <p className={styles.footerNote}>
          Already have an account?{" "}
          <Link className={styles.link} href={signInHref(destination)}>
            Sign in
          </Link>
        </p>
        <p className={styles.footerNote}>
          <Link className={styles.link} href="/forgot-password">
            Forgot your password?
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <form
        className={styles.form}
        onSubmit={handleSubmit}
        noValidate
        aria-busy={submitting}
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email
          </label>
          <input
            className={styles.input}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "register-error" : "register-hint"}
            required
          />
          <p className={styles.hint} id="register-hint">
            We&apos;ll email you a link to confirm the address and choose your
            password.
          </p>
        </div>

        {error ? (
          <p
            className={styles.error}
            role="alert"
            id="register-error"
            data-testid="register-error"
          >
            {error}
          </p>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Sending…" : "Continue"}
        </button>
      </form>

      <GoogleSignInButton returnPath={destination} />

      <p className={styles.footerNote}>
        Already have an account?{" "}
        <Link className={styles.link} href={signInHref(destination)}>
          Sign in
        </Link>
      </p>
      <p className={styles.footerNote}>
        <Link className={styles.link} href="/forgot-password">
          Forgot your password?
        </Link>
      </p>
    </>
  );
}
