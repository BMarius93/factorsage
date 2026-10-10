import {
  BILLING_PERSONA_PASSWORD_ENV,
  type BillingPersona,
} from "@intrinsic/testing/billing-personas";
import { e2eEnv } from "./env";

/**
 * Sign-in credentials for a billing persona.
 *
 * The address comes from the shared registry in `@intrinsic/testing/billing-personas` — it is the
 * same identity the Stripe fixtures are tagged with — and the one shared password from the
 * environment. Nothing else about a billing persona is configured here, and nothing here can
 * change one: its plan and subscription exist because Stripe says so and the application's
 * reconciliation agreed, before this suite started.
 */
export function billingPersonaCredentials(persona: BillingPersona): {
  readonly email: string;
  readonly password: string;
} {
  const password = e2eEnv(BILLING_PERSONA_PASSWORD_ENV);
  if (!password) {
    throw new Error(
      `The billing persona suite requires ${BILLING_PERSONA_PASSWORD_ENV}. Set it, then seed the ` +
        "personas into the test database with `pnpm qa:billing:seed -- --database test` so they " +
        "can sign in. See docs/development/billing-qa-personas.md.",
    );
  }
  return { email: persona.email, password };
}
