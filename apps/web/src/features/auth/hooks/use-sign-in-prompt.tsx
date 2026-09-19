"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SignInPrompt } from "../components/SignInPrompt";
import { useSessionStateIfProvided } from "./session-state";

export type SignInPromptCopy = {
  readonly title: string;
  readonly body: string;
  /**
   * Where signing in should land, when that is not the page being read — "Run backtest" from a
   * strategy returns to the prefilled New Backtest, not to the strategy (UI-042). Validated by
   * the same safe-return rules as every `next`.
   */
  readonly next?: string;
};

export type SignInGate = {
  /**
   * Whether the viewer has an account. `false` while the session is still resolving, so an action
   * is never offered before the answer is known.
   */
  readonly signedIn: boolean;
  /** The session has settled, either way. */
  readonly resolved: boolean;
  /** True once we know there is no session. */
  readonly guest: boolean;
  /**
   * Runs `action` for a signed-in viewer, and asks a Guest for an account instead. The viewer stays
   * on the page they were reading either way.
   */
  readonly attempt: (copy: SignInPromptCopy, action: () => void) => void;
  /** Render inside the page so the prompt has somewhere to appear. */
  readonly prompt: ReactNode;
};

/**
 * The one way a page asks a Guest for an account before an action that needs one.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 5.1 refuses anonymous persistence, and
 * navigating away to `/login` would throw away whatever the visitor was reading to say so. This
 * keeps them where they are and offers the two real answers — sign in, or create an account —
 * through the existing `SignInPrompt` modal rather than a second implementation of it.
 */
export function useSignInPrompt(): SignInGate {
  const state = useSessionStateIfProvided() ?? { status: "loading" as const };
  const [copy, setCopy] = useState<SignInPromptCopy | null>(null);

  const signedIn = state.status === "authenticated";
  const resolved = state.status !== "loading";
  const close = useCallback(() => setCopy(null), []);

  const attempt = useCallback(
    (requested: SignInPromptCopy, action: () => void) => {
      if (signedIn) {
        action();
        return;
      }
      setCopy(requested);
    },
    [signedIn],
  );

  const prompt = useMemo(
    () =>
      copy ? (
        <SignInPrompt
          title={copy.title}
          body={copy.body}
          {...(copy.next ? { next: copy.next } : {})}
          onClose={close}
        />
      ) : null,
    [copy, close],
  );

  return { signedIn, resolved, guest: resolved && !signedIn, attempt, prompt };
}
