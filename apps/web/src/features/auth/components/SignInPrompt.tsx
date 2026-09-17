"use client";

import Link from "next/link";
import { Modal } from "../../../components/ui/Modal";
import forms from "../../../components/ui/forms.module.css";
import styles from "./SignInPrompt.module.css";

type SignInPromptProps = {
  readonly title: string;
  readonly body: string;
  readonly onClose: () => void;
};

/**
 * Asks a Guest to sign in before an action that needs an account. Nothing is stored for a Guest,
 * so the only honest answer to "remember this for me" is an account.
 */
export function SignInPrompt({ title, body, onClose }: SignInPromptProps) {
  return (
    <Modal title={title} onClose={onClose} testId="sign-in-prompt">
      <p className={styles.body}>{body}</p>
      <div className={styles.actions}>
        <Link className={forms.primaryButton} href="/login">
          Sign in
        </Link>
        <Link className={forms.secondaryButton} href="/register">
          Create an account
        </Link>
      </div>
    </Modal>
  );
}
