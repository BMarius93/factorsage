import { Suspense } from "react";
import { AuthCard } from "../../features/auth/components/AuthCard";
import { VerifyEmailRoute } from "./VerifyEmailRoute";

export const metadata = {
  title: "Verify your email | FactorSage",
};

export default function VerifyEmailPage() {
  return (
    <AuthCard title="Email verification">
      {/* The token arrives in the query string, so verification runs client-side. */}
      <Suspense fallback={null}>
        <VerifyEmailRoute />
      </Suspense>
    </AuthCard>
  );
}
