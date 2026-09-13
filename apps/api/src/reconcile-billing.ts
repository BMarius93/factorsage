import {
  describeStripeMode,
  openBillingCliContext,
} from "./billing/billing-cli-context";
import { BillingReconciliationService } from "./billing/billing-reconciliation.service";

/**
 * `pnpm billing:reconcile` — the deterministic billing repair seam.
 *
 * Webhook delivery is the normal synchronization path, but it is not the only one that may ever have
 * worked: `docs/decisions/stripe-billing-v1.md` section 16 requires a path that rebuilds local
 * billing state from current Stripe state without fabricating a webhook. Use it after a missed
 * delivery, a deployment outage, a database restore, or when a user reports the wrong plan.
 *
 * It calls `BillingReconciliationService.reconcileUser` — the same function webhooks call, under the
 * same advisory lock, in the same transaction. Running it while a webhook is being processed for the
 * same user is therefore safe: one waits for the other and both converge, because the operation is
 * "make local state match Stripe", not "apply a delta".
 *
 * ```bash
 * # One user, by email or by id.
 * pnpm billing:reconcile -- --user someone@example.com
 * pnpm billing:reconcile -- --user 0f4c...-uuid
 *
 * # Everyone who has ever touched billing: a Stripe customer or a mirrored subscription.
 * # Users who have neither are skipped — there is nothing to reconcile and no Stripe call to make.
 * pnpm billing:reconcile -- --all
 *
 * # Report what would change without writing anything.
 * pnpm billing:reconcile -- --all --dry-run
 * ```
 *
 * `--dry-run` reports the *current* persisted state and what Stripe holds, and makes no write. It is
 * implemented by reading rather than by a rolled-back transaction, so it cannot itself take a lock a
 * live request needs.
 */

type Options = {
  readonly user: string | null;
  readonly all: boolean;
  readonly dryRun: boolean;
};

function parseArgs(argv: readonly string[]): Options {
  let user: string | null = null;
  let all = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      // pnpm forwards the `--` separator itself to the script, so `pnpm billing:reconcile -- --all`
      // arrives as `["--", "--all"]`. Both that form and a bare `--all` have to work: the separator
      // is the documented and safer invocation, and rejecting it made the documented command fail.
      continue;
    }
    if (arg === "--all") {
      all = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--user") {
      user = argv[index + 1] ?? null;
      index += 1;
    } else if (arg?.startsWith("--user=")) {
      user = arg.slice("--user=".length);
    } else if (arg) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!all && !user) {
    throw new Error(
      "Specify --user <email|id> or --all.\n" +
        "  pnpm billing:reconcile -- --user someone@example.com\n" +
        "  pnpm billing:reconcile -- --all [--dry-run]",
    );
  }
  if (all && user) {
    throw new Error("--user and --all are mutually exclusive");
  }

  return { user, all, dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const context = await openBillingCliContext();

  try {
    console.log(`Stripe environment: ${describeStripeMode(context.config)}`);
    if (options.dryRun) {
      console.log("Dry run: nothing will be written.\n");
    }

    const userIds = options.all
      ? await billingUserIds(context)
      : [await resolveUser(context, options.user as string)];

    if (userIds.length === 0) {
      console.log("No users have billing state to reconcile.");
      return;
    }

    const reconciliation = new BillingReconciliationService(
      context.prisma,
      context.logger,
      context.stripe,
      context.catalog,
    );

    let changed = 0;
    let anomalies = 0;

    for (const userId of userIds) {
      const before = await context.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, plan: true, stripeCustomerId: true },
      });
      if (!before) {
        console.log(`${userId}: no such user, skipped`);
        continue;
      }

      if (options.dryRun) {
        const mirror = await context.prisma.billingSubscription.findUnique({
          where: { userId },
        });
        console.log(
          `${before.email}: plan=${before.plan} ` +
            `customer=${before.stripeCustomerId ? "yes" : "none"} ` +
            `subscription=${mirror ? `${mirror.plan ?? "UNKNOWN_PRICE"}/${mirror.status}` : "none"} ` +
            `reason=${mirror?.planReason ?? "NO_SUBSCRIPTION"} ` +
            `syncedAt=${mirror?.syncedAt.toISOString() ?? "never"}`,
        );
        continue;
      }

      try {
        const result = await reconciliation.reconcileUser({
          userId,
          trigger: "MANUAL",
        });
        if (result.planChanged) {
          changed += 1;
        }
        if (result.anomalous) {
          anomalies += 1;
        }
        console.log(
          `${before.email}: ${result.previousPlan} -> ${result.plan}` +
            `${result.planChanged ? " (CHANGED)" : ""}` +
            ` [${result.planReason}, ${result.subscriptionStatus ?? "no subscription"}]` +
            `${result.anomalous ? " *** NEEDS ATTENTION ***" : ""}`,
        );
      } catch (error: unknown) {
        // One user's failure must not abandon the rest of a batch: a single Stripe timeout would
        // otherwise leave an outage half-repaired with no record of where it stopped.
        anomalies += 1;
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`${before.email}: FAILED — ${message}`);
      }
    }

    if (!options.dryRun) {
      console.log(
        `\n${userIds.length} user(s) reconciled, ${changed} plan change(s), ` +
          `${anomalies} needing attention.`,
      );
    }
  } finally {
    await context.close();
  }
}

/** Every user with any billing footprint. Users with none need no Stripe call at all. */
async function billingUserIds(
  context: Awaited<ReturnType<typeof openBillingCliContext>>,
): Promise<string[]> {
  const users = await context.prisma.user.findMany({
    where: {
      OR: [
        { stripeCustomerId: { not: null } },
        { billingSubscription: { isNot: null } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return users.map((user) => user.id);
}

/** A user id, or an email resolved to one. Emails are the operator's handle, never Stripe's. */
async function resolveUser(
  context: Awaited<ReturnType<typeof openBillingCliContext>>,
  identifier: string,
): Promise<string> {
  const byId = await context.prisma.user.findUnique({
    where: { id: identifier },
    select: { id: true },
  });
  if (byId) {
    return byId.id;
  }

  const byEmail = await context.prisma.user.findUnique({
    where: { email: identifier.trim().toLowerCase() },
    select: { id: true },
  });
  if (byEmail) {
    return byEmail.id;
  }

  throw new Error(`No user matches '${identifier}' by id or email`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Billing reconciliation failed: ${message}`);
  process.exitCode = 1;
});
