"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { requestPasswordReset } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";

/**
 * Deliberately neutral, and deliberately shown for every address.
 *
 * The API answers identically for an unknown address, an account that signs in with Google, and
 * an account that really was mailed a link, so the copy must not imply the address exists —
 * otherwise the UI leaks exactly what the endpoint refuses to.
 */
export const RESET_REQUESTED_MESSAGE =
  "If that address has a FactorSage account with a password, a reset link is on its way. Check your inbox and spam folder.";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div data-testid="forgot-password-sent">
        <p className={styles.success} role="status">
          {RESET_REQUESTED_MESSAGE}
        </p>
        <p className={styles.status}>
          The link can be used once and expires. Requesting another one replaces
          it.
        </p>
        <p className={styles.footerNote}>
          <Link className={styles.link} href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
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
            required
          />
        </div>

        {error ? (
          <p
            className={styles.error}
            role="alert"
            data-testid="forgot-password-error"
          >
            {error}
          </p>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Sending..." : "Send reset link"}
        </button>
      </form>

      <p className={styles.footerNote}>
        Remembered it?{" "}
        <Link className={styles.link} href="/login">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
