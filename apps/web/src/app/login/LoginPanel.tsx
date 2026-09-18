"use client";

import { useSearchParams } from "next/navigation";
import { LoginForm } from "../../features/auth/components/LoginForm";
import { describeOAuthError } from "../../features/auth/utils/auth-errors";
import { safeReturnPath } from "../../features/auth/utils/return-path";

/**
 * Reads the `error` the API attaches when a Google redirect could not be completed, and the `next`
 * destination a sign-in prompt or the route gate sent the visitor here with (UX-003).
 */
export function LoginPanel() {
  const searchParams = useSearchParams();
  return (
    <LoginForm
      providerError={describeOAuthError(searchParams.get("error"))}
      returnPath={safeReturnPath(searchParams.get("next"))}
    />
  );
}
