"use client";

import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { resetPassword } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";

export const PASSWORD_MISMATCH_MESSAGE = "Both passwords must match.";
export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const MISSING_TOKEN_MESSAGE =
  "This page needs a password reset link. Open the most recent link from your inbox.";

/**
 * Sets a new password from the link in the user's inbox.
 *
 * The token is carried straight through to the API and never interpreted here — the browser
 * cannot tell a valid link from an expired one, and must not pretend otherwise.
 */
export function ResetPasswordForm({
  token,
}: {
  readonly token: string | null;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
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

    setSubmitting(true);
    setError(null);

    try {
      await resetPassword({ token, password });
      setDone(true);
    } catch (caught) {
      setError(describeRequestError(caught));
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div data-testid="reset-password-missing-token">
        <p className={styles.error} role="alert">
          {MISSING_TOKEN_MESSAGE}
        </p>
        <p className={styles.footerNote}>
          <Link className={styles.link} href="/forgot-password">
            Request a new link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div data-testid="reset-password-success">
        <p className={styles.success} role="status">
          Your password has been changed.
        </p>
        <p className={styles.footerNote}>
          <Link className={styles.link} href="/login">
            Continue to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
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
            Confirm new password
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
          <p
            className={styles.error}
            role="alert"
            data-testid="reset-password-error"
          >
            {error}
          </p>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Changing password..." : "Change password"}
        </button>
      </form>

      <p className={styles.footerNote}>
        Link expired?{" "}
        <Link className={styles.link} href="/forgot-password">
          Request a new one
        </Link>
      </p>
    </>
  );
}
