import { AuthCard } from "../../features/auth/components/AuthCard";
import { RegisterForm } from "../../features/auth/components/RegisterForm";

export const metadata = {
  title: "Create an account | FactorSage",
};

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      subtitle="Start with your email address. We'll send a link to confirm it and choose your password."
    >
      <RegisterForm />
    </AuthCard>
  );
}
