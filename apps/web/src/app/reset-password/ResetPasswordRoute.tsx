"use client";

import { useSearchParams } from "next/navigation";
import { ResetPasswordForm } from "../../features/auth/components/ResetPasswordForm";

export function ResetPasswordRoute() {
  const searchParams = useSearchParams();
  return <ResetPasswordForm token={searchParams.get("token")} />;
}
