"use client";

import { PASSWORD_MIN_LENGTH } from "@intrinsic/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { register } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";
import { GoogleSignInButton } from "./GoogleSignInButton";

export const PASSWORD_MISMATCH_MESSAGE = "Both passwords must match.";
export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;

export function RegisterForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

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
      await register({ email, password });
      setRegisteredEmail(email);
    } catch (caught) {
      setError(describeRequestError(caught));
      setSubmitting(false);
    }
  }

  if (registeredEmail) {
    return (
      <div data-testid="register-success">
        <p className={styles.success} role="status">
          Check your inbox. We sent a verification link to {registeredEmail}.
        </p>
        <p className={styles.status}>
          The link can be used once and expires. You can sign in as soon as your
          address is verified.
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            Password
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
          <p className={styles.error} role="alert" data-testid="register-error">
            {error}
          </p>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>

      <GoogleSignInButton />

      <p className={styles.footerNote}>
        Already have an account?{" "}
        <Link className={styles.link} href="/login">
          Sign in
        </Link>
      </p>
    </>
  );
}
