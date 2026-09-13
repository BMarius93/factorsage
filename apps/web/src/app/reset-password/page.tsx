import { Suspense } from "react";
import { AuthCard } from "../../features/auth/components/AuthCard";
import { ResetPasswordRoute } from "./ResetPasswordRoute";

export const metadata = {
  title: "Choose a new password | FactorSage",
};

export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password">
      {/* The token arrives in the query string, so the form renders client-side. */}
      <Suspense fallback={null}>
        <ResetPasswordRoute />
      </Suspense>
    </AuthCard>
  );
}
