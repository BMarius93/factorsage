"use client";

import Link from "next/link";
import { Modal } from "../../../components/ui/Modal";
import forms from "../../../components/ui/forms.module.css";
import { registerHref, signInHref } from "../utils/guest-routes";
import { currentReturnPath } from "../utils/return-path";
import styles from "./SignInPrompt.module.css";

type SignInPromptProps = {
  readonly title: string;
  readonly body: string;
  /** The intended destination after signing in; the page being read when omitted. */
  readonly next?: string;
  readonly onClose: () => void;
};

/**
 * Asks a Guest to sign in before an action that needs an account. Nothing is stored for a Guest,
 * so the only honest answer to "remember this for me" is an account.
 *
 * Both links carry the page the Guest is reading — path and query — as `?next=`, so signing in
 * returns them to it instead of dropping them on the Dashboard (UX-003).
 */
export function SignInPrompt({
  title,
  body,
  next: intended,
  onClose,
}: SignInPromptProps) {
  // Only ever mounted after a click, so this reads the live location on the client.
  const next = intended ?? currentReturnPath();
  return (
    <Modal title={title} onClose={onClose} testId="sign-in-prompt">
      <p className={styles.body}>{body}</p>
      {/* The dialog rule (UI-056): secondary then primary, and on a phone the primary stacks on
          top — the same `forms.actions` row every dialog uses. */}
      <div className={forms.actions}>
        <Link className={forms.secondaryButton} href={registerHref(next)}>
          Create an account
        </Link>
        <Link className={forms.primaryButton} href={signInHref(next)}>
          Sign in
        </Link>
      </div>
    </Modal>
  );
}
