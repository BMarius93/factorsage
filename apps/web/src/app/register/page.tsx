import { AuthCard } from "../../features/auth/components/AuthCard";
import { RegisterForm } from "../../features/auth/components/RegisterForm";

export const metadata = {
  title: "Create an account | FactorSage",
};

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      subtitle="We will email you a link to confirm your address before your first sign-in."
    >
      <RegisterForm />
    </AuthCard>
  );
}
