import { createInterface } from "node:readline/promises";
import {
  failCommand,
  openBillingPersonaCli,
  parseBillingPersonaArgs,
} from "./billing-personas/billing-persona-cli";
import {
  cleanupBillingPersonaFixtures,
  type BillingPersonaCleanupResult,
} from "./billing-personas/billing-persona-tooling";

/**
 * `pnpm qa:billing:cleanup` — removes the billing QA persona fixtures from Stripe test mode, and
 * their billing state from FactorSage.
 *
 * ```bash
 * pnpm qa:billing:cleanup                       # preview, confirm, then remove
 * pnpm qa:billing:cleanup -- --dry-run          # print what would be removed and stop
 * pnpm qa:billing:cleanup -- --yes              # no prompt (required in a non-interactive shell)
 * pnpm qa:billing:cleanup -- --database test    # the hermetic test database's personas
 * pnpm qa:billing:cleanup -- --all-tagged       # every fixture this tooling ever created
 * ```
 *
 * What it deletes in Stripe is **Test Clocks** this tooling created — recognised by a name and
 * metadata that must agree in full — and, with each, the one customer and subscription on it.
 * Nothing else: no product, no price, no customer that arrived through Checkout, no clock somebody
 * else made. A clock that looks like a fixture but is not consistently tagged is refused, named,
 * and left alone, and the command then exits non-zero.
 *
 * By default it removes the fixtures of **this database's** billing persona accounts. `--all-tagged`
 * widens that to every fixture the tooling created in the Stripe account — the way to clear what
 * another database, a deleted account or an interrupted run left behind.
 *
 * Each account is detached and reconciled before its Stripe customer goes, so it ends as an
 * ordinary `FREE` account with no mirror, by the application's own path. The accounts are kept.
 */

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function print(result: BillingPersonaCleanupResult): void {
  const verb = result.dryRun ? "would delete" : "deleted";
  for (const fixture of result.fixtures) {
    console.log(
      `  ${verb} test clock ${fixture.clockId}: ${fixture.persona}, ` +
        `customer ${fixture.customerId ?? "none"}, owner ${fixture.ownerUserId}`,
    );
  }
  for (const email of result.staleLinks) {
    console.log(
      `  ${result.dryRun ? "would clear" : "cleared"} the stale Stripe customer link of ${email}`,
    );
  }
  if (result.fixtures.length === 0 && result.staleLinks.length === 0) {
    console.log("  nothing to remove");
  }
  if (result.outOfScope > 0) {
    console.log(
      `  ${result.outOfScope} fixture(s) of other owners left alone (use --all-tagged to ` +
        "include them)",
    );
  }
  for (const refusal of result.refusals) {
    console.error(`  REFUSED: ${refusal}`);
  }
}

async function main(): Promise<void> {
  // No `--persona`: a cleanup is scoped by who owns a fixture, never by a name typed on a flag.
  const options = parseBillingPersonaArgs(
    process.argv.slice(2),
    ["--dry-run", "--yes", "-y", "--all-tagged"],
    { personas: false },
  );
  const dryRun = options.flags.has("--dry-run");
  const assumeYes = options.flags.has("--yes") || options.flags.has("-y");
  const scope = options.flags.has("--all-tagged") ? "ALL_TAGGED" : "DATABASE";

  const cli = await openBillingPersonaCli({
    command: "pnpm qa:billing:cleanup",
    target: options.database,
  });

  try {
    console.log(
      scope === "ALL_TAGGED"
        ? "Scope: every billing persona fixture in this Stripe account."
        : `Scope: the fixtures of ${cli.database.databaseName}'s billing persona accounts.`,
    );

    const preview = await cleanupBillingPersonaFixtures(cli.tooling, {
      scope,
      dryRun: true,
    });
    print(preview);
    const pending = preview.fixtures.length + preview.staleLinks.length;

    if (dryRun) {
      console.log("Dry run: nothing was deleted.");
    } else if (pending > 0) {
      if (!assumeYes) {
        if (!process.stdin.isTTY) {
          console.error(
            "Refusing to delete without confirmation. Rerun with --yes to clean up " +
              "non-interactively.",
          );
          process.exitCode = 1;
          return;
        }
        if (
          !(await confirm("Delete the Stripe test-mode fixtures above? [y/N] "))
        ) {
          console.log("Cancelled. Nothing was deleted.");
          return;
        }
      }
      const result = await cleanupBillingPersonaFixtures(cli.tooling, {
        scope,
        dryRun: false,
      });
      console.log("Done:");
      print(result);
      if (result.refusals.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    if (preview.refusals.length > 0) {
      console.error(
        "Something that looks like a billing persona fixture could not be proven to be one. " +
          "It was left untouched; inspect it in the Stripe Dashboard.",
      );
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
}

void main().catch(failCommand("Billing persona cleanup failed"));
