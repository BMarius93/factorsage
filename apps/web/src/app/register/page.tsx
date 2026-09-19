import { Suspense } from "react";
import { AuthCard } from "../../features/auth/components/AuthCard";
import { RegisterPanel } from "./RegisterPanel";

export const metadata = {
  title: "Create an account · FactorSage",
};

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      subtitle="Start with your email address. We'll send a link to confirm it and choose your password."
    >
      {/* The panel reads the return destination from the query string, so it renders client-side. */}
      <Suspense fallback={null}>
        <RegisterPanel />
      </Suspense>
    </AuthCard>
  );
}
