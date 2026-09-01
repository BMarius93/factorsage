"use client";

import { useSearchParams } from "next/navigation";
import { VerifyEmailPanel } from "../../features/auth/components/VerifyEmailPanel";

export function VerifyEmailRoute() {
  const searchParams = useSearchParams();
  return <VerifyEmailPanel token={searchParams.get("token")} />;
}
