"use client";

import { useState } from "react";
import { resendVerification } from "../api/auth-api";
import { describeRequestError } from "../utils/auth-errors";
import styles from "./auth-form.module.css";
import { RESEND_CONFIRMATION } from "./ResendVerificationForm";

type ResendState = "idle" | "sending" | "sent" | "error";

/**
 * Resends verification for an address the user has already typed.
 *
 * Reusing the known address avoids putting a second field labelled "Email" on a screen that
 * already has one.
 */
export function ResendVerificationButton({
  email,
}: {
  readonly email: string;
}) {
  const [state, setState] = useState<ResendState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setState("sending");
    setError(null);

    try {
      await resendVerification(email);
      setState("sent");
    } catch (caught) {
      setError(describeRequestError(caught));
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" data-testid="resend-confirmation">
        {RESEND_CONFIRMATION}
      </p>
    );
  }

  return (
    <>
      <button
        className={styles.linkButton}
        type="button"
        disabled={state === "sending"}
        onClick={handleClick}
      >
        {state === "sending" ? "Sending..." : "Send a new verification link"}
      </button>
      {error ? <p className={styles.error}>{error}</p> : null}
    </>
  );
}
