"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { login } from "../api/auth-api";
import { describeLoginFailure } from "../utils/auth-errors";
import styles from "./auth-form.module.css";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { ResendVerificationButton } from "./ResendVerificationButton";

/** Where a signed-in browser lands; the API decides what that user may actually see. */
const POST_LOGIN_PATH = "/dashboard";

type LoginFormProps = {
  /** Message produced by a failed provider redirect back from the API. */
  readonly providerError?: string | null;
};

export function LoginForm({ providerError = null }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setUnverified(false);

    try {
      await login({ email, password });
      router.replace(POST_LOGIN_PATH);
      router.refresh();
    } catch (caught) {
      const failure = describeLoginFailure(caught);
      if (failure.kind === "email_not_verified") {
        setUnverified(true);
      } else {
        setError(failure.message);
      }
      setSubmitting(false);
    }
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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
          />
        </div>

        {providerError ? (
          <p className={styles.error} role="alert">
            {providerError}
          </p>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}

        {unverified ? (
          <div
            className={styles.notice}
            role="alert"
            data-testid="login-unverified"
          >
            <p>
              Verify your email address before signing in. Check your inbox for
              the link we sent you.
            </p>
            <ResendVerificationButton email={email} />
          </div>
        ) : null}

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>

      <GoogleSignInButton />

      <p className={styles.footerNote}>
        New to FactorSage?{" "}
        <Link className={styles.link} href="/register">
          Create an account
        </Link>
      </p>
    </>
  );
}
