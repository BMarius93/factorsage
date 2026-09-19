"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { login } from "../api/auth-api";
import { describeLoginFailure } from "../utils/auth-errors";
import { useRedirectIfSignedIn } from "../hooks/use-redirect-if-signed-in";
import { forgotPasswordHref, registerHref } from "../utils/guest-routes";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "../utils/return-path";
import styles from "./auth-form.module.css";
import { GoogleSignInButton } from "./GoogleSignInButton";

type LoginFormProps = {
  /** Message produced by a failed provider redirect back from the API. */
  readonly providerError?: string | null;
  /**
   * Where a successful sign-in lands: the page the visitor came from, or the Dashboard. The API
   * decides what that user may actually see there. Validated again here, so an unchecked value
   * can never reach the router.
   */
  readonly returnPath?: string;
};

export const EMAIL_REQUIRED_MESSAGE = "Enter your email address.";
export const PASSWORD_REQUIRED_MESSAGE = "Enter your password.";

export function LoginForm({
  providerError = null,
  returnPath = DEFAULT_RETURN_PATH,
}: LoginFormProps) {
  const destination = safeReturnPath(returnPath);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    readonly email?: string;
    readonly password?: string;
  }>({});
  const redirecting = useRedirectIfSignedIn(destination);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // An empty field is answered here, beside the field, rather than by a request that could only
    // come back as "those credentials" (UI-041).
    const missing = {
      ...(email.trim() === "" ? { email: EMAIL_REQUIRED_MESSAGE } : {}),
      ...(password === "" ? { password: PASSWORD_REQUIRED_MESSAGE } : {}),
    };
    setFieldErrors(missing);
    if (missing.email || missing.password) {
      setError(null);
      document.getElementById(missing.email ? "email" : "password")?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      await login({ email, password });
      router.replace(destination);
      router.refresh();
    } catch (caught) {
      setError(describeLoginFailure(caught));
      setSubmitting(false);
    }
  }

  if (redirecting) {
    return (
      <p
        className={styles.status}
        role="status"
        data-testid="auth-already-signed-in"
      >
        You are already signed in. Taking you back…
      </p>
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
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldErrors((current) => ({ ...current, email: undefined }));
            }}
            disabled={submitting}
            required
            aria-invalid={fieldErrors.email ? true : undefined}
            {...(fieldErrors.email
              ? { "aria-describedby": "email-error" }
              : {})}
          />
          {fieldErrors.email ? (
            <p className={styles.fieldError} id="email-error">
              {fieldErrors.email}
            </p>
          ) : null}
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
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldErrors((current) => ({
                ...current,
                password: undefined,
              }));
            }}
            disabled={submitting}
            required
            aria-invalid={fieldErrors.password ? true : undefined}
            {...(fieldErrors.password
              ? { "aria-describedby": "password-error" }
              : {})}
          />
          {fieldErrors.password ? (
            <p className={styles.fieldError} id="password-error">
              {fieldErrors.password}
            </p>
          ) : null}
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
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <GoogleSignInButton returnPath={destination} />

      <p className={styles.footerNote}>
        <Link className={styles.link} href={forgotPasswordHref(destination)}>
          Forgot your password?
        </Link>
      </p>

      <p className={styles.footerNote}>
        New to FactorSage?{" "}
        <Link className={styles.link} href={registerHref(destination)}>
          Create an account
        </Link>
      </p>
    </>
  );
}
