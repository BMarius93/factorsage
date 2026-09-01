"use client";

import { useState, type FormEvent } from "react";
import { resendVerification } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";

/**
 * Deliberately neutral: the API answers identically for unknown, unverified, and
 * already-verified addresses, so the UI must not imply the address exists.
 */
export const RESEND_CONFIRMATION =
  "If that address needs verifying, a new link is on its way. Check your inbox and spam folder.";

/** Requests a fresh verification link for an address the user still has to type. */
export function ResendVerificationForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await resendVerification(email);
      setSent(true);
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <p
        className={styles.success}
        role="status"
        data-testid="resend-confirmation"
      >
        {RESEND_CONFIRMATION}
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="resend-email">
          Email
        </label>
        <input
          className={styles.input}
          id="resend-email"
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
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <button
        className={styles.primaryButton}
        type="submit"
        disabled={submitting}
      >
        {submitting ? "Sending..." : "Send a new link"}
      </button>
    </form>
  );
}
