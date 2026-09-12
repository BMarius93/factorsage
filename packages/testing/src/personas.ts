import type { UserPlan, UserRole } from "@intrinsic/contracts";

/**
 * The official FactorSage test personas.
 *
 * One definition, read by everything: the persona seeder, the entitlement-fixture seeder, the
 * Playwright projects and the documentation. Emails, passwords, plans, roles and storage-state
 * paths are therefore never written down twice, which is what stops a persona meaning `PRO` in the
 * seeder and `STARTER` in a spec.
 *
 * **Why personas rather than one mutable account.** Entitlements are per-plan behaviour, so
 * testing them by moving one user between plans makes every test order-dependent and every
 * parallel run a race. A persona per plan is a fixed point: a spec signs in as the plan it is
 * about and never changes anyone's plan.
 *
 * `GUEST` is deliberately absent from this table. It is the derived access state for "no
 * authenticated session" — `docs/decisions/entitlements-v1.md` requires it to create no row — so
 * there is nothing to seed and nothing to sign in as. It is named by {@link GUEST_PERSONA} so a
 * spec can still refer to it.
 *
 * Credentials come from the environment and are never committed. Each persona names its own
 * variable prefix; `PRO_USER` and `ADMIN_USER` keep the historical `QA_USER_*` and `QA_ADMIN_*`
 * names so an existing `.env` and an existing CI secret keep working unchanged.
 */

export const GUEST_PERSONA = "GUEST" as const;

export type GuestPersona = typeof GUEST_PERSONA;

export const TEST_PERSONA_NAMES = [
  "FREE_USER",
  "STARTER_USER",
  "PRO_USER",
  "ADMIN_USER",
  "DOWNGRADED_USER",
] as const;

export type TestPersonaName = (typeof TEST_PERSONA_NAMES)[number];

/** Every access state a spec may target, including the one that has no account. */
export type PersonaName = TestPersonaName | GuestPersona;

export type TestPersona = {
  readonly name: TestPersonaName;
  /** Persisted commercial plan. */
  readonly plan: UserPlan;
  /** Persisted authorization role. Orthogonal to the plan, and never sold. */
  readonly role: UserRole;
  /**
   * Environment-variable prefix for this persona's credentials: `<prefix>_EMAIL` and
   * `<prefix>_PASSWORD`.
   */
  readonly envPrefix: string;
  /** Where Playwright keeps this persona's signed-in storage state. Git-ignored. */
  readonly storageState: string;
  /** What this persona exists for. Read by the docs and by anyone choosing one. */
  readonly purpose: string;
};

export const TEST_PERSONAS: Readonly<Record<TestPersonaName, TestPersona>> = {
  FREE_USER: {
    name: "FREE_USER",
    plan: "FREE",
    role: "USER",
    envPrefix: "QA_FREE",
    storageState: "playwright/.auth/free.json",
    purpose:
      "The smallest paid-for capacity. Used for the boundary cases — a list at ten symbols, a " +
      "five-year backtest, one active monitor — where the limit is what is being proven.",
  },
  STARTER_USER: {
    name: "STARTER_USER",
    plan: "STARTER",
    role: "USER",
    envPrefix: "QA_STARTER",
    storageState: "playwright/.auth/starter.json",
    purpose:
      "The middle tier. Proves a limit moved with the plan rather than being hard-coded, which " +
      "a two-tier test can never show.",
  },
  PRO_USER: {
    name: "PRO_USER",
    plan: "PRO",
    role: "USER",
    // The historical `QA_USER` variables: this persona *is* the long-standing default development
    // account, now stated in plan terms.
    envPrefix: "QA_USER",
    storageState: "playwright/.auth/user.json",
    purpose:
      "The default account for local development and manual testing, and the persona every " +
      "non-entitlement E2E spec signs in as. It is deliberately a commercial customer and not an " +
      "administrator: developing against an account with entitlement overrides would hide every " +
      "commercial capacity bug until production.",
  },
  ADMIN_USER: {
    name: "ADMIN_USER",
    // FREE on purpose. Plan and role are orthogonal, and an administrator on the smallest plan is
    // the configuration that proves it: the capability comes from the role alone.
    plan: "FREE",
    role: "ADMIN",
    envPrefix: "QA_ADMIN",
    storageState: "playwright/.auth/admin.json",
    purpose:
      "Internal and QA scenarios that intentionally need `ADMIN_ENTITLEMENTS` — administrative " +
      "surfaces, and the developer QA validation matrix. Never the default development account.",
  },
  DOWNGRADED_USER: {
    name: "DOWNGRADED_USER",
    plan: "FREE",
    role: "USER",
    envPrefix: "QA_DOWNGRADED",
    storageState: "playwright/.auth/downgraded.json",
    purpose:
      "A FREE account holding content created under a higher tier: an oversized list, a " +
      "completed backtest, and more enabled monitors than FREE allows. Those states are not " +
      "reachable through the UI by design, so they are seeded; keeping them on their own persona " +
      "is what stops them colliding with FREE_USER's boundary cases.",
  },
};

/** The persona local development and manual testing should sign in as. */
export const DEFAULT_DEVELOPMENT_PERSONA: TestPersonaName = "PRO_USER";

export function testPersona(name: TestPersonaName): TestPersona {
  return TEST_PERSONAS[name];
}

export const TEST_PERSONA_LIST: readonly TestPersona[] =
  TEST_PERSONA_NAMES.map((name) => TEST_PERSONAS[name]);

/** `<prefix>_EMAIL` and `<prefix>_PASSWORD` for one persona. */
export function personaCredentialEnvNames(persona: TestPersona): {
  readonly email: string;
  readonly password: string;
} {
  return {
    email: `${persona.envPrefix}_EMAIL`,
    password: `${persona.envPrefix}_PASSWORD`,
  };
}
