"use client";

import { useSearchParams } from "next/navigation";
import { LoginForm } from "../../features/auth/components/LoginForm";
import { describeOAuthError } from "../../features/auth/utils/auth-errors";

/** Reads the `error` the API attaches when a Google redirect could not be completed. */
export function LoginPanel() {
  const searchParams = useSearchParams();
  return (
    <LoginForm providerError={describeOAuthError(searchParams.get("error"))} />
  );
}
