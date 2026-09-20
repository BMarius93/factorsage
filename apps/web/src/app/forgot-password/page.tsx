import { AuthCard } from "../../features/auth/components/AuthCard";
import { Suspense } from "react";
import { ForgotPasswordPanel } from "./ForgotPasswordPanel";

export const metadata = {
  title: "Reset your password · FactorSage",
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new password."
    >
      {/* The return destination is in the query string, so the form renders client-side. */}
      <Suspense fallback={null}>
        <ForgotPasswordPanel />
      </Suspense>
    </AuthCard>
  );
}
