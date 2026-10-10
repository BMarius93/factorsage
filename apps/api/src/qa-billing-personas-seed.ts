import {
  BILLING_PERSONA_PASSWORD_ENV,
  type BillingPersona,
} from "@intrinsic/testing";
import {
  describeLocalState,
  describeStripeSubscription,
  failCommand,
  openBillingPersonaCli,
  parseBillingPersonaArgs,
  requireVerifiedCatalog,
} from "./billing-personas/billing-persona-cli";
import { resolveBillingPersonaPassword } from "./billing-personas/billing-persona-environment";
import { seedBillingPersona } from "./billing-personas/billing-persona-tooling";

/**
 * `pnpm qa:billing:seed` — makes the billing QA personas true, in Stripe test mode and then, through
 * reconciliation, in FactorSage.
 *
 * ```bash
 * pnpm qa:billing:seed                                # every persona, development database
 * pnpm qa:billing:seed -- --database test             # the hermetic test database instead
 * pnpm qa:billing:seed -- --persona starter-past-due  # one persona (repeatable)
 * ```
 *
 * Per persona: a Stripe Test Clock, a customer on it, a real subscription on one configured
 * catalog price, and whatever its lifecycle needs — a scheduled cancellation, a renewal against a
 * card that fails, the paid period ending. Then `BillingReconciliationService.reconcileUser`, which
 * is the only thing that writes the persona's `BillingSubscription` and `User.plan`.
 *
 * Convergent: a persona already in its declared state is left alone, and the run makes no Stripe
 * write for it. Anything else of that persona's — a fixture an interrupted run abandoned, one that
 * drifted — is removed and rebuilt. Refuses production, a non-local database, an unconfigured or
 * live Stripe key, and a catalog `pnpm billing:verify-catalog` would reject. Exits non-zero if any
 * persona could not be brought to its declared state.
 *
 * `docs/development/billing-qa-personas.md` is the runbook.
 */
async function main(): Promise<void> {
  const options = parseBillingPersonaArgs(process.argv.slice(2), []);
  const cli = await openBillingPersonaCli({
    command: "pnpm qa:billing:seed",
    target: options.database,
  });

  try {
    if (!(await requireVerifiedCatalog(cli.context))) {
      process.exitCode = 1;
      return;
    }

    const password = resolveBillingPersonaPassword();
    if (password === null) {
      console.log(
        `${BILLING_PERSONA_PASSWORD_ENV} is not set: the accounts are created without a ` +
          "password, so nobody can sign in as them until it is set and this is run again.",
      );
    }

    const failed: BillingPersona[] = [];
    for (const persona of options.personas) {
      console.log(`\n${persona.name} (${persona.email})`);
      try {
        const result = await seedBillingPersona(cli.tooling, persona, {
          password,
        });
        console.log(
          `  Stripe:     ${result.stripe}, ` +
            describeStripeSubscription(result.subscription, persona),
        );
        console.log(`  FactorSage: ${describeLocalState(result.local)}`);
        if (result.problems.length === 0) {
          console.log("  CONVERGED");
        } else {
          failed.push(persona);
          for (const problem of result.problems) {
            console.error(`  NOT CONVERGED: ${problem}`);
          }
        }
      } catch (error: unknown) {
        // One persona's failure must not abandon the others: each is an independent fixture.
        failed.push(persona);
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`  FAILED: ${message}`);
      }
    }

    console.log(
      `\n${options.personas.length - failed.length} of ${options.personas.length} billing ` +
        "persona(s) are in their declared state.",
    );
    if (failed.length > 0) {
      console.error(
        `Not converged: ${failed.map((persona) => persona.name).join(", ")}`,
      );
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
}

void main().catch(failCommand("Billing persona seed failed"));
