"use client";

import { useSearchParams } from "next/navigation";
import { ForgotPasswordForm } from "../../features/auth/components/ForgotPasswordForm";
import { safeReturnPath } from "../../features/auth/utils/return-path";

/** Reads the `next` destination the sign-in page sent the visitor here with (UI-042). */
export function ForgotPasswordPanel() {
  const searchParams = useSearchParams();
  return (
    <ForgotPasswordForm returnPath={safeReturnPath(searchParams.get("next"))} />
  );
}
