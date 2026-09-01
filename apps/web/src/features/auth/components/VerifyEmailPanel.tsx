"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { verifyEmail } from "../api/auth-api";
import styles from "./auth-form.module.css";
import { ResendVerificationForm } from "./ResendVerificationForm";

type VerificationState = "missing" | "verifying" | "verified" | "invalid";

/**
 * Completes verification for the link in the user's inbox.
 *
 * The link lands on the web application, which redeems the token through the API; the token is
 * never interpreted in the browser beyond passing it along.
 */
export function VerifyEmailPanel({ token }: { readonly token: string | null }) {
  const [state, setState] = useState<VerificationState>(
    token ? "verifying" : "missing",
  );

  useEffect(() => {
    if (!token) {
      setState("missing");
      return;
    }

    let active = true;
    setState("verifying");

    void verifyEmail(token)
      .then(() => {
        if (active) setState("verified");
      })
      .catch(() => {
        if (active) setState("invalid");
      });

    return () => {
      active = false;
    };
  }, [token]);

  if (state === "verifying") {
    return (
      <p className={styles.status} role="status" data-testid="verify-pending">
        Verifying your email address...
      </p>
    );
  }

  if (state === "verified") {
    return (
      <div data-testid="verify-success">
        <p className={styles.success} role="status">
          Your email address is verified.
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
    <div data-testid="verify-failure">
      <p className={styles.error} role="alert">
        {state === "missing"
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
        <Link className={styles.link} href="/login">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
