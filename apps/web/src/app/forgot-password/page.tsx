import { AuthCard } from "../../features/auth/components/AuthCard";
import { ForgotPasswordForm } from "../../features/auth/components/ForgotPasswordForm";

export const metadata = {
  title: "Reset your password | FactorSage",
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      subtitle="We will email you a link to choose a new password."
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
