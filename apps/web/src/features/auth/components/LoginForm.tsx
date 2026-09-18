"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { login } from "../api/auth-api";
import { describeLoginFailure } from "../utils/auth-errors";
import styles from "./auth-form.module.css";
import { GoogleSignInButton } from "./GoogleSignInButton";

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await login({ email, password });
      router.replace(POST_LOGIN_PATH);
      router.refresh();
    } catch (caught) {
      setError(describeLoginFailure(caught));
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
        <Link className={styles.link} href="/forgot-password">
          Forgot your password?
        </Link>
      </p>

      <p className={styles.footerNote}>
        New to FactorSage?{" "}
        <Link className={styles.link} href="/register">
          Create an account
        </Link>
      </p>
    </>
  );
}
