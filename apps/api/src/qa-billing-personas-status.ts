import {
  describeLocalState,
  describeStripeSubscription,
  failCommand,
  openBillingPersonaCli,
  parseBillingPersonaArgs,
} from "./billing-personas/billing-persona-cli";
import {
  inspectBillingPersona,
  observeBillingPersonaFixtures,
} from "./billing-personas/billing-persona-tooling";

/**
 * `pnpm qa:billing:status` — what each billing QA persona is, in Stripe and in FactorSage.
 *
 * ```bash
 * pnpm qa:billing:status                       # development database
 * pnpm qa:billing:status -- --database test    # the hermetic test database
 * pnpm qa:billing:status -- --check            # exit non-zero unless every persona is CONVERGED
 * ```
 *
 * Reads only: it creates nothing in Stripe and does not reconcile. For each persona it prints the
 * Stripe fixture, FactorSage's persisted plan and mirror, and a verdict — `CONVERGED`,
 * `NOT_SEEDED`, `STRIPE_DRIFT`, `LOCAL_DRIFT`, `STALE_LINK` or `AMBIGUOUS` — with the reasons.
 *
 * It also reports the fixtures this tooling created that do **not** belong to this database's
 * personas (another database's, an interrupted run's, a deleted account's) and anything that
 * claims to be a fixture without being consistently tagged, so stale test objects are visible
 * before anybody decides to remove them.
 */
async function main(): Promise<void> {
  const options = parseBillingPersonaArgs(process.argv.slice(2), ["--check"]);
  const cli = await openBillingPersonaCli({
    command: "pnpm qa:billing:status",
    target: options.database,
  });

  try {
    const observed = await observeBillingPersonaFixtures(cli.tooling.fixtures);
    const accounted = new Set<string>();
    let unconverged = 0;

    for (const persona of options.personas) {
      const status = await inspectBillingPersona(
        cli.tooling,
        persona,
        observed,
      );
      console.log(`\n${persona.name} (${persona.email})`);

      const fixture = status.fixture;
      if (fixture) {
        accounted.add(fixture.clock.id);
        console.log(
          `  Stripe:     test clock ${fixture.clock.id} ${fixture.clock.status}, ` +
            `frozen at ${fixture.clock.frozenTime.toISOString()}` +
            (fixture.clock.deletesAfter
              ? `, deleted by Stripe after ${fixture.clock.deletesAfter.toISOString()}`
              : ""),
        );
        console.log(
          `              customer ${fixture.customer?.id ?? "none"}` +
            fixture.subscriptions
              .map(
                (subscription) =>
                  `, ${describeStripeSubscription(subscription, persona)}`,
              )
              .join(""),
        );
      } else {
        console.log("  Stripe:     no fixture");
      }
      console.log(
        `  FactorSage: ${status.local ? describeLocalState(status.local) : "no account"}`,
      );
      console.log(`  ${status.verdict}`);
      if (status.verdict !== "CONVERGED") {
        unconverged += 1;
        for (const problem of status.problems) {
          console.log(`    - ${problem}`);
        }
      }
    }

    const others = observed.filter(
      (fixture) => fixture.kind === "OWNED" && !accounted.has(fixture.clock.id),
    );
    const ambiguous = observed.filter(
      (fixture) => fixture.kind === "AMBIGUOUS",
    );
    if (others.length > 0) {
      console.log(
        `\n${others.length} other billing persona fixture(s) exist in this Stripe account and ` +
          "are not shown above (another database's, or left by an interrupted run):",
      );
      for (const fixture of others) {
        if (fixture.kind === "OWNED") {
          console.log(
            `  test clock ${fixture.clock.id}: ${fixture.identity.persona}, ` +
              `owner ${fixture.identity.ownerUserId}`,
          );
        }
      }
      console.log(
        "`pnpm qa:billing:cleanup -- --all-tagged` removes them; the default cleanup leaves " +
          "them alone.",
      );
    }
    if (ambiguous.length > 0) {
      console.log(
        `\n${ambiguous.length} test clock(s) claim to be billing persona fixtures but are not ` +
          "consistently tagged. Nothing will touch them:",
      );
      for (const fixture of ambiguous) {
        if (fixture.kind === "AMBIGUOUS") {
          console.log(
            `  test clock ${fixture.clock.id} (${fixture.clock.name ?? "unnamed"}): ` +
              fixture.reasons.join("; "),
          );
        }
      }
    }

    if (options.flags.has("--check") && unconverged > 0) {
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
}

void main().catch(failCommand("Billing persona status failed"));
