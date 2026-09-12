import type { UserPlan } from "@intrinsic/contracts";
import { UserPlan as PersistedUserPlan } from "@intrinsic/database";
import type { PrismaClient } from "@intrinsic/database";

/**
 * The billing integration boundary — and the only place the persisted commercial plan is written.
 *
 * `docs/decisions/entitlements-v1.md` section 11 fixes the direction:
 *
 * ```text
 * Stripe subscription state -> internal persisted plan -> central entitlement resolver -> guards
 * ```
 *
 * A future billing adapter maps provider price/product ids onto `UserPlan` at its own edge and
 * calls {@link changeUserPlan}. Nothing downstream of this function knows a biller exists, so
 * entitlement resolution has no dependency on one and keeps working with no billing configured at
 * all — which is what makes the entitlement implementation independently usable before Stripe is
 * connected.
 *
 * Two things this deliberately cannot do. It cannot grant or remove `ADMIN`: role is authorization,
 * is never sold, and is never touched here. And it cannot be reached from a request body — the API
 * exposes no route that writes a plan, so a forged request has nothing to aim at.
 */

/** Why a plan changed. Recorded for observability; never an input to entitlement resolution. */
export type PlanChangeSource =
  /** A future billing provider webhook or reconciliation job. */
  | "BILLING"
  /** An operator acting deliberately, through a seeded fixture or an administrative tool. */
  | "ADMIN"
  /** Development and test fixtures. */
  | "FIXTURE";

export type PlanChange = {
  readonly userId: string;
  readonly previousPlan: UserPlan;
  readonly plan: UserPlan;
  readonly changed: boolean;
  readonly source: PlanChangeSource;
};

/** The subset of a Prisma client this needs; satisfied by a client and by a transaction client. */
export type UserPlanClient = Pick<PrismaClient, "user">;

/**
 * Moves a user onto a plan and reports what actually changed.
 *
 * **Non-destructive by construction.** It writes one column. No List is truncated, no Strategy,
 * Backtest result or Monitor is deleted, and no Monitor's `enabled` intent is rewritten, because a
 * downgrade must never destroy content the user created under a higher plan. What a downgrade
 * changes is what *new* operations are permitted, and that is derived from this column at the
 * moment each operation is attempted.
 */
export async function changeUserPlan(
  db: UserPlanClient,
  input: { userId: string; plan: UserPlan; source: PlanChangeSource },
): Promise<PlanChange> {
  const previous = await db.user.findUnique({
    where: { id: input.userId },
    select: { plan: true },
  });
  if (!previous) {
    throw new Error(`Cannot change the plan of unknown user ${input.userId}`);
  }

  const changed = previous.plan !== input.plan;
  if (changed) {
    await db.user.update({
      where: { id: input.userId },
      data: { plan: PersistedUserPlan[input.plan] },
    });
  }

  return {
    userId: input.userId,
    previousPlan: previous.plan,
    plan: input.plan,
    changed,
    source: input.source,
  };
}
