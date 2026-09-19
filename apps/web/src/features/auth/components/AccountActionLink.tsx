"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  useSignInPrompt,
  type SignInPromptCopy,
} from "../hooks/use-sign-in-prompt";

type AccountActionLinkProps = {
  /** Where a signed-in viewer goes, prefill query included. */
  readonly href: string;
  /** What a Guest is asked instead of being sent there. */
  readonly prompt: SignInPromptCopy;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
};

/**
 * A link to a page that needs an account, on a page a Guest may read (UX-002).
 *
 * A signed-in viewer gets a real link — middle-click, a new tab and the status bar all work. A
 * Guest gets a button that asks for an account in place: following the link would bounce them off
 * a protected route to `/login` and throw away the page they were reading, which is exactly what
 * `guest-routes.ts` promises never happens. While the session is still resolving the control is a
 * disabled button, because a link a Guest would follow is the one wrong answer and a prompt
 * shown to somebody already signed in is the other.
 */
export function AccountActionLink({
  href,
  prompt,
  className,
  testId,
  children,
}: AccountActionLinkProps) {
  const gate = useSignInPrompt();
  const common = {
    ...(className ? { className } : {}),
    ...(testId ? { "data-testid": testId } : {}),
  };

  if (gate.signedIn) {
    return (
      <Link {...common} href={href}>
        {children}
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        {...common}
        disabled={!gate.resolved}
        onClick={() => {
          if (gate.resolved) {
            // Signing in lands on the action's own destination (the prefilled form), which is
            // what the Guest asked for; `signInHref` validates it like any other `next`.
            gate.attempt({ ...prompt, next: href }, () => {});
          }
        }}
      >
        {children}
      </button>
      {gate.prompt}
    </>
  );
}
