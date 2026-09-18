"use client";

import { useSearchParams } from "next/navigation";
import { RegisterForm } from "../../features/auth/components/RegisterForm";
import { safeReturnPath } from "../../features/auth/utils/return-path";

/** Reads the `next` destination a sign-in prompt sent the visitor here with (UX-003). */
export function RegisterPanel() {
  const searchParams = useSearchParams();
  return <RegisterForm returnPath={safeReturnPath(searchParams.get("next"))} />;
}
