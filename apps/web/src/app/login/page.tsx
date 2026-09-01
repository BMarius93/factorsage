import { Suspense } from "react";
import { AuthCard } from "../../features/auth/components/AuthCard";
import { LoginPanel } from "./LoginPanel";

export const metadata = {
  title: "Sign in | FactorSage",
};

export default function LoginPage() {
  return (
    <AuthCard
      title="Sign in"
      subtitle="Valuation, backtesting, and monitoring for your watchlists."
    >
      {/* The panel reads the redirect error from the query string, so it renders client-side. */}
      <Suspense fallback={null}>
        <LoginPanel />
      </Suspense>
    </AuthCard>
  );
}
