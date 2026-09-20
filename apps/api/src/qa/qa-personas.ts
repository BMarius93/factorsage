import type { PrismaClient } from "@intrinsic/database";

/**
 * What `pnpm qa:reset` removes, and — just as importantly — the shape that makes it impossible for
 * it to remove anything else.
 *
 * Every statement below is scoped by `userId: { in: <the resolved persona ids> }`. There is no code
 * path that issues a `deleteMany` without that filter: the ids are resolved first, from the
 * persona emails in the environment, and if none resolve nothing runs at all. A `userId` filter
 * also never matches `SYSTEM`-owned built-in content, whose `userId` is null (invariant 21), so
 * built-ins survive a reset untouched and keep appearing exactly as they do for a real customer.
 *
 * The `User` rows themselves are kept. Deleting and recreating them would change their ids, which
 * would invalidate the persistent browser profiles' sessions and defeat the point of the tooling.
 */

/** One persona's content, before and after. Printed so a reset reports what it actually did. */
export type QaPersonaContentCounts = {
  readonly stockLists: number;
  readonly strategies: number;
  readonly monitors: number;
  readonly backtestRuns: number;
  readonly builtInMonitorPreferences: number;
  readonly recentSecurityViews: number;
};

export type QaPersonaReset = {
  readonly name: string;
  readonly email: string;
  readonly userId: string;
  readonly deleted: QaPersonaContentCounts;
  /**
   * Whether this persona carries a `BillingSubscription` mirror.
   *
   * Reported rather than deleted. The mirror is Stripe's state as this installation last
   * reconciled it (invariant 18), and `BillingReconciliationService` is its only writer; deleting
   * it here would make a QA tool the second writer of billing state. If a persona was used for
   * Stripe test-mode checkout, the next reconciliation may legitimately move its plan away from the
   * one this command re-asserted — so the operator is told, and decides.
   */
  readonly hasBillingSubscription: boolean;
};

const EMPTY_COUNTS: QaPersonaContentCounts = {
  stockLists: 0,
  strategies: 0,
  monitors: 0,
  backtestRuns: 0,
  builtInMonitorPreferences: 0,
  recentSecurityViews: 0,
};

/** Locates the persona rows to act on. Missing personas are simply absent from the result. */
export async function findQaPersonaUsers(
  prisma: PrismaClient,
  personas: readonly { name: string; email: string }[],
): Promise<{ name: string; email: string; userId: string }[]> {
  const found: { name: string; email: string; userId: string }[] = [];
  for (const persona of personas) {
    const user = await prisma.user.findUnique({
      where: { email: persona.email },
      select: { id: true },
    });
    if (user) {
      found.push({ name: persona.name, email: persona.email, userId: user.id });
    }
  }
  return found;
}

/**
 * Counts what a reset would remove, without removing it.
 *
 * `pnpm qa:reset` shows this and waits for a `y` before deleting anything. `PRO_USER` is also the
 * long-standing default development account (`ai/workflows/auth-testing.md`), so a developer's own
 * manual work usually *is* what the numbers describe — which makes "how much, exactly" the
 * question worth answering before the deletion rather than after it.
 */
export async function countQaPersonaContent(
  prisma: PrismaClient,
  userId: string,
): Promise<QaPersonaContentCounts> {
  const [
    stockLists,
    strategies,
    monitors,
    backtestRuns,
    builtInMonitorPreferences,
    recentSecurityViews,
  ] = await Promise.all([
    prisma.stockList.count({ where: { userId } }),
    prisma.strategy.count({ where: { userId } }),
    prisma.monitor.count({ where: { userId } }),
    prisma.backtestRun.count({ where: { userId } }),
    prisma.userBuiltInMonitorPreference.count({ where: { userId } }),
    prisma.recentSecurityView.count({ where: { userId } }),
  ]);
  return {
    stockLists,
    strategies,
    monitors,
    backtestRuns,
    builtInMonitorPreferences,
    recentSecurityViews,
  };
}

/**
 * Deletes exactly the product content these personas created, and nothing else.
 *
 * Ordered by the schema's own referential rules rather than by convenience. A `Monitor` holds
 * `onDelete: Restrict` references to its `Strategy` and `StockList` — deliberately, so a live
 * Monitor cannot be silently emptied — so Monitors go first or the strategy delete is refused.
 * `BacktestRun` follows: its snapshot is the reproducibility authority and its strategy/list
 * references are `SetNull`, so a run outlives the objects it was built from and has to be removed
 * explicitly rather than cascaded away.
 *
 * Everything runs in one transaction, so a reset either happens or does not; a half-reset persona
 * would be worse than no reset, because it looks clean and is not.
 */
export async function resetQaPersonaContent(
  prisma: PrismaClient,
  personas: readonly { name: string; email: string; userId: string }[],
): Promise<QaPersonaReset[]> {
  if (personas.length === 0) {
    return [];
  }

  const results: QaPersonaReset[] = [];
  for (const persona of personas) {
    const userId = persona.userId;
    const deleted = await prisma.$transaction(
      async (tx): Promise<QaPersonaContentCounts> => {
        const monitors = await tx.monitor.deleteMany({ where: { userId } });
        const backtestRuns = await tx.backtestRun.deleteMany({
          where: { userId },
        });
        const strategies = await tx.strategy.deleteMany({ where: { userId } });
        const stockLists = await tx.stockList.deleteMany({ where: { userId } });
        // Per-user Dashboard visibility of built-in Monitors: the one piece of per-user state a
        // built-in has (invariant 21). Clearing it is what makes a reset persona's Dashboard look
        // like a brand-new account's rather than like one that has already hidden things.
        const builtInMonitorPreferences =
          await tx.userBuiltInMonitorPreference.deleteMany({
            where: { userId },
          });
        const recentSecurityViews = await tx.recentSecurityView.deleteMany({
          where: { userId },
        });
        return {
          monitors: monitors.count,
          backtestRuns: backtestRuns.count,
          strategies: strategies.count,
          stockLists: stockLists.count,
          builtInMonitorPreferences: builtInMonitorPreferences.count,
          recentSecurityViews: recentSecurityViews.count,
        };
      },
      // A persona that ran a long manual session can own a few thousand equity rows behind its
      // runs; the default five-second interactive budget is not the right one for a cleanup.
      { timeout: 60_000 },
    );

    const billing = await prisma.billingSubscription.findUnique({
      where: { userId },
      select: { userId: true },
    });

    results.push({
      name: persona.name,
      email: persona.email,
      userId,
      deleted,
      hasBillingSubscription: billing !== null,
    });
  }

  return results;
}

export function totalDeleted(counts: QaPersonaContentCounts): number {
  return (
    counts.stockLists +
    counts.strategies +
    counts.monitors +
    counts.backtestRuns +
    counts.builtInMonitorPreferences +
    counts.recentSecurityViews
  );
}

export function describeDeletedCounts(counts: QaPersonaContentCounts): string {
  if (totalDeleted(counts) === 0) {
    return "already empty";
  }
  return [
    `${counts.stockLists} list(s)`,
    `${counts.strategies} strateg(ies)`,
    `${counts.monitors} monitor(s)`,
    `${counts.backtestRuns} backtest run(s)`,
    `${counts.builtInMonitorPreferences} built-in preference(s)`,
    `${counts.recentSecurityViews} recent view(s)`,
  ].join(", ");
}

export { EMPTY_COUNTS as EMPTY_QA_PERSONA_CONTENT_COUNTS };
