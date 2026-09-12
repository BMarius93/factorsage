import {
  BillingError,
  occupiesPaidSlot,
  resolveEffectivePlan,
  type BillingInterval,
  type BillingPlanReason,
  type BillingSubscriptionStatus,
  type UserPlan,
} from "@intrinsic/contracts";
import {
  BillingInterval as PersistedInterval,
  BillingSubscriptionStatus as PersistedStatus,
  UserPlan as PersistedPlan,
  lockUserEntitlementScope,
  type Prisma,
} from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { changeUserPlan } from "../entitlements/user-plan";
import { BillingCatalog } from "./billing-catalog";
import {
  BILLING_CATALOG_TOKEN,
  BILLING_LOGGER,
  STRIPE_GATEWAY,
} from "./billing.tokens";
import {
  toMirroredStatus,
  type StripeCustomerBillingState,
  type StripeGateway,
  type StripeSubscriptionState,
} from "./stripe-gateway";

/**
 * The one canonical billing state transition in FactorSage.
 *
 * Webhooks, the plan-change endpoint, the status route and the repair CLI all converge here. There
 * is deliberately no second implementation of these rules for tooling — `docs/decisions/
 * stripe-billing-v1.md` section 16 requires repair and normal sync to be the *same* code, which is
 * the only way a repaired user is provably in the state a webhook would have produced.
 *
 * The question it answers is always the same one:
 *
 * ```text
 * Given the current Stripe customer/subscription state, what billing mirror
 * and what effective FactorSage plan should exist now?
 * ```
 *
 * ## Why Stripe is fetched *inside* the transaction
 *
 * This is the design decision worth understanding before changing anything here.
 *
 * Stripe events arrive out of order, duplicated and concurrently. Reconciling from the event payload
 * would make correctness depend on arrival order, so every path instead refetches canonical Stripe
 * state. That alone is not enough: two reconciliations could each fetch, then interleave their
 * writes, and the one that fetched *earlier* could commit *last* — a stale snapshot overwriting a
 * newer one, which is precisely the "a delayed older webhook must never downgrade or upgrade a user
 * incorrectly" failure.
 *
 * The fix here is structural rather than optimistic: the user's advisory lock is taken first, and
 * the Stripe read happens **after** it, inside the same transaction. There is then no window in
 * which two fetches can interleave — the second reconciliation reads Stripe only after the first has
 * committed, so it reads the newer state and converges. A freshness-timestamp comparison would be
 * the alternative, and it would be wrong in exactly one case: two API instances with skewed clocks.
 *
 * The cost is real and bounded: one database connection is held across a Stripe API call. Stripe
 * calls are capped by `STRIPE_TIMEOUT_MS` and the transaction by {@link TRANSACTION_TIMEOUT_MS}, and
 * billing volume is a few events per user per month — orders of magnitude below anything that
 * contends for the pool.
 *
 * ## Which lock
 *
 * `lockUserEntitlementScope`, the same per-user advisory lock every capacity-controlled write takes
 * — not a new billing lock. `User.plan` is the input to every entitlement decision, so a plan change
 * and a list add that counts against that plan genuinely must serialize. Reusing the key also keeps
 * the repository's acquisition order intact: the entitlement lock is always taken first, before any
 * row lock, so reconciliation cannot deadlock against a backtest submission or a list mutation.
 */

/** How long one reconciliation may hold its transaction: a Stripe round trip plus a few writes. */
const TRANSACTION_TIMEOUT_MS = 30_000;

/** How long it may wait to *start* one; a queue longer than this means the pool is the problem. */
const TRANSACTION_MAX_WAIT_MS = 10_000;

export type ReconciliationTrigger =
  /** A verified Stripe webhook. */
  | "WEBHOOK"
  /** The operator repair CLI. */
  | "MANUAL"
  /** Immediately after this server asked Stripe to change something. */
  | "PLAN_CHANGE"
  /** The browser came back from a hosted Stripe surface and asked for fresh status. */
  | "RETURN";

/** A webhook's identity, recorded in the same transaction as the change it authorizes. */
export type WebhookEventRecord = {
  readonly stripeEventId: string;
  readonly type: string;
  readonly stripeCreatedAt: Date;
};

export type ReconciliationOutcome =
  /** State was compared and written; `planChanged` says whether the plan moved. */
  | "APPLIED"
  /** This Stripe event id had already been processed. Nothing was done. */
  | "DUPLICATE_EVENT"
  /** The user has no Stripe customer, so there is nothing to mirror. */
  | "NO_CUSTOMER";

export type ReconciliationResult = {
  readonly outcome: ReconciliationOutcome;
  readonly userId: string;
  readonly previousPlan: UserPlan;
  readonly plan: UserPlan;
  readonly planChanged: boolean;
  readonly planReason: BillingPlanReason;
  readonly subscriptionStatus: BillingSubscriptionStatus | null;
  /** True when an operator should look: an unsupported status, a foreign price, two live subs. */
  readonly anomalous: boolean;
};

/** What the mirror row should contain after this reconciliation. */
type DesiredMirror = {
  readonly stripeSubscriptionId: string;
  readonly stripePriceId: string;
  readonly plan: UserPlan | null;
  readonly billingInterval: BillingInterval | null;
  readonly status: BillingSubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelAt: Date | null;
  readonly canceledAt: Date | null;
  readonly pendingPlan: UserPlan | null;
  readonly pendingInterval: BillingInterval | null;
  readonly pendingPriceId: string | null;
  readonly pendingEffectiveAt: Date | null;
  readonly stripeScheduleId: string | null;
};

@Injectable()
export class BillingReconciliationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BILLING_LOGGER) private readonly logger: StructuredLogger,
    @Optional()
    @Inject(STRIPE_GATEWAY)
    private readonly stripe: StripeGateway | null,
    @Optional()
    @Inject(BILLING_CATALOG_TOKEN)
    private readonly catalog: BillingCatalog | null,
  ) {}

  get configured(): boolean {
    return this.stripe !== null && this.catalog !== null;
  }

  /**
   * Rebuilds one user's billing mirror and plan from current Stripe state.
   *
   * Idempotent by construction: it compares desired state against persisted state rather than
   * applying a delta, so running it twice, or a hundred times, converges on the same row and the
   * same plan. That is what makes it safe as both the webhook path and the repair path.
   */
  async reconcileUser(input: {
    readonly userId: string;
    readonly trigger: ReconciliationTrigger;
    readonly webhookEvent?: WebhookEventRecord;
    /**
     * A Stripe Customer this event proves belongs to the user, adopted if the local link is missing.
     *
     * The self-healing seam for a restored database or a link lost to a manual edit: without it a
     * `checkout.session.completed` resolved through session metadata would reconcile a user who has
     * no `stripeCustomerId` straight to FREE, discarding the purchase that just succeeded. Adoption
     * never overwrites an existing link and never steals a customer another user already owns.
     */
    readonly adoptStripeCustomerId?: string;
  }): Promise<ReconciliationResult> {
    const { stripe, catalog } = this.requireConfigured();
    const startedAt = Date.now();

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // First, always. Everything below — including the Stripe read — happens serialized per
          // user, which is what makes a stale snapshot impossible rather than merely unlikely.
          await lockUserEntitlementScope(tx, input.userId);

          if (input.webhookEvent) {
            // Before the Stripe call, so a duplicate delivery costs nothing and a rollback (a
            // transient Stripe failure, a crash) takes the marker with it and leaves the event
            // genuinely unprocessed for Stripe to retry.
            await tx.stripeWebhookEvent.create({
              data: {
                stripeEventId: input.webhookEvent.stripeEventId,
                type: input.webhookEvent.type,
                stripeCreatedAt: input.webhookEvent.stripeCreatedAt,
                userId: input.userId,
                outcome: "APPLIED",
              },
            });
          }

          const user = await tx.user.findUnique({
            where: { id: input.userId },
            select: { id: true, plan: true, stripeCustomerId: true },
          });
          if (!user) {
            throw new BillingError("No such account", {
              code: "BILLING_CUSTOMER_CONFLICT",
            });
          }

          const existing = await tx.billingSubscription.findUnique({
            where: { userId: input.userId },
          });

          let customerId = user.stripeCustomerId;
          let adoptionConflict = false;

          if (!customerId && input.adoptStripeCustomerId) {
            const owner = await tx.user.findUnique({
              where: { stripeCustomerId: input.adoptStripeCustomerId },
              select: { id: true },
            });
            if (!owner) {
              await tx.user.update({
                where: { id: input.userId },
                data: { stripeCustomerId: input.adoptStripeCustomerId },
              });
              customerId = input.adoptStripeCustomerId;
              this.logger.warn({
                event: "billing.customer.adopted",
                actorUserId: input.userId,
                reason: "missing-local-link",
              });
            } else if (owner.id !== input.userId) {
              // Two FactorSage users cannot share a Stripe Customer. Recorded loudly and left
              // alone: repointing it would move somebody else's subscription onto this account.
              adoptionConflict = true;
              this.logger.error({
                event: "billing.invariant.customer-owned-by-another-user",
                actorUserId: input.userId,
                conflictingUserId: owner.id,
              });
            }
          }

          if (!customerId) {
            // No customer means nothing was ever bought. A mirror row without a customer is
            // impossible state left by a restore or a manual edit, so it is removed and the plan
            // falls to FREE through the same write path as everything else.
            if (existing) {
              await tx.billingSubscription.delete({
                where: { userId: input.userId },
              });
            }
            const change = await changeUserPlan(tx, {
              userId: input.userId,
              plan: "FREE",
              source: "BILLING",
            });
            return {
              outcome: "NO_CUSTOMER" as const,
              previousPlan: change.previousPlan,
              plan: change.plan,
              planChanged: change.changed,
              planReason: "NO_SUBSCRIPTION" as BillingPlanReason,
              subscriptionStatus: null,
              anomalous: existing !== null || adoptionConflict,
            };
          }

          const state = await stripe.loadCustomerBillingState(customerId);

          const canonical = this.chooseCanonicalSubscription(
            state,
            existing?.stripeSubscriptionId ?? null,
            input.userId,
          );

          const desired = canonical
            ? this.describeMirror(canonical.subscription, state, catalog)
            : null;

          const decision = resolveEffectivePlan(
            desired
              ? {
                  status: desired.status,
                  plan: desired.plan === "FREE" ? null : (desired.plan ?? null),
                  interval: desired.billingInterval,
                }
              : null,
          );

          if (desired) {
            const data = {
              stripeSubscriptionId: desired.stripeSubscriptionId,
              stripePriceId: desired.stripePriceId,
              plan: toPersistedPlan(desired.plan),
              billingInterval: toPersistedInterval(desired.billingInterval),
              status: PersistedStatus[desired.status],
              currentPeriodStart: desired.currentPeriodStart,
              currentPeriodEnd: desired.currentPeriodEnd,
              cancelAtPeriodEnd: desired.cancelAtPeriodEnd,
              cancelAt: desired.cancelAt,
              canceledAt: desired.canceledAt,
              pendingPlan: toPersistedPlan(desired.pendingPlan),
              pendingInterval: toPersistedInterval(desired.pendingInterval),
              pendingPriceId: desired.pendingPriceId,
              pendingEffectiveAt: desired.pendingEffectiveAt,
              stripeScheduleId: desired.stripeScheduleId,
              planReason: decision.reason,
              syncedAt: new Date(),
              ...(input.webhookEvent
                ? { lastStripeEventCreatedAt: input.webhookEvent.stripeCreatedAt }
                : {}),
            };

            if (
              existing &&
              existing.stripeSubscriptionId !== desired.stripeSubscriptionId
            ) {
              // The canonical subscription changed identity — a resubscribe after cancellation, or
              // a conflict resolved onto a different one. `userId` is unique, so the row is
              // replaced rather than a second one inserted.
              await tx.billingSubscription.delete({
                where: { userId: input.userId },
              });
              await tx.billingSubscription.create({
                data: { userId: input.userId, ...data },
              });
            } else {
              await tx.billingSubscription.upsert({
                where: { userId: input.userId },
                create: { userId: input.userId, ...data },
                update: data,
              });
            }
          } else if (existing) {
            await tx.billingSubscription.delete({
              where: { userId: input.userId },
            });
          }

          // The single write path onto the plan column, in the same transaction as the mirror that
          // justifies it. `User.plan = PRO` and the subscription row proving it commit together or
          // not at all (decision document section 13).
          const change = await changeUserPlan(tx, {
            userId: input.userId,
            plan: decision.plan,
            source: "BILLING",
          });

          return {
            outcome: "APPLIED" as const,
            previousPlan: change.previousPlan,
            plan: change.plan,
            planChanged: change.changed,
            planReason: decision.reason,
            subscriptionStatus: desired?.status ?? null,
            anomalous: decision.anomalous || (canonical?.conflict ?? false),
          };
        },
        { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
      );

      const full: ReconciliationResult = { userId: input.userId, ...result };
      this.logReconciliation(input.trigger, full, Date.now() - startedAt);
      await this.releaseSpentSchedule(input.userId, stripe);
      return full;
    } catch (error: unknown) {
      if (input.webhookEvent && isDuplicateEventError(error)) {
        this.logger.info({
          event: "billing.webhook.duplicate",
          actorUserId: input.userId,
          stripeEventId: input.webhookEvent.stripeEventId,
          type: input.webhookEvent.type,
        });
        const current = await this.readPlan(input.userId);
        return {
          outcome: "DUPLICATE_EVENT",
          userId: input.userId,
          previousPlan: current,
          plan: current,
          planChanged: false,
          planReason: "NO_SUBSCRIPTION",
          subscriptionStatus: null,
          anomalous: false,
        };
      }

      this.logger.error({
        event: "billing.reconciliation.failed",
        actorUserId: input.userId,
        trigger: input.trigger,
        durationMs: Date.now() - startedAt,
        ...(input.webhookEvent
          ? { stripeEventId: input.webhookEvent.stripeEventId }
          : {}),
        err: error,
      });
      throw error;
    }
  }

  /**
   * Detaches a Subscription Schedule that has already applied its change.
   *
   * **Not tidiness — it is what keeps cancellation working.** Stripe refuses to change any
   * cancellation behaviour on a subscription while a schedule manages it, and Customer Portal's cancel
   * button does exactly that. A schedule whose final phase is open-ended never ends, so
   * `end_behavior: release` never fires on its own: left alone, every user who once changed plan or
   * cadence would permanently lose the ability to cancel. Sandbox testing is where that surfaced.
   *
   * Runs **after** the transaction, deliberately. It is an external mutation, and a rollback could not
   * undo it; doing it outside means a failure here leaves local state correct and simply retries on the
   * next reconciliation. That also makes it self-healing: any webhook, refresh or repair run finds a
   * stuck schedule and clears it, so an existing stuck subscription is fixed by
   * `pnpm billing:reconcile`.
   *
   * A failure is logged and swallowed. The billing state is already correct and committed; refusing the
   * whole reconciliation over a detach would be strictly worse.
   */
  private async releaseSpentSchedule(
    userId: string,
    stripe: StripeGateway,
  ): Promise<void> {
    try {
      const mirror = await this.prisma.billingSubscription.findUnique({
        where: { userId },
        select: { stripeScheduleId: true, pendingPriceId: true, status: true },
      });

      // A schedule with a pending change still has work to do. One with none has applied it.
      if (!mirror?.stripeScheduleId || mirror.pendingPriceId !== null) {
        return;
      }

      await stripe.releaseSubscriptionSchedule(mirror.stripeScheduleId);
      await this.prisma.billingSubscription.updateMany({
        where: { userId, stripeScheduleId: mirror.stripeScheduleId },
        data: { stripeScheduleId: null },
      });
      this.logger.info({
        event: "billing.schedule.released",
        actorUserId: userId,
        reason: "pending-change-applied",
      });
    } catch (error: unknown) {
      this.logger.warn({
        event: "billing.schedule.release-failed",
        actorUserId: userId,
        err: error,
      });
    }
  }

  /**
   * Records an event this deployment cannot act on, so Stripe stops retrying it.
   *
   * An unknown customer, an event from another Stripe account, an event type with no local subject.
   * No lock and no transaction are needed because no state changes — but the row is written anyway,
   * because "we received it and deliberately did nothing" is the answer a support investigation
   * needs, and silence is indistinguishable from a dropped webhook.
   */
  async recordIgnoredEvent(input: {
    readonly event: WebhookEventRecord;
    readonly outcome: string;
    readonly userId?: string;
  }): Promise<void> {
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: input.event.stripeEventId,
          type: input.event.type,
          stripeCreatedAt: input.event.stripeCreatedAt,
          userId: input.userId ?? null,
          outcome: input.outcome,
        },
      });
    } catch (error: unknown) {
      if (isDuplicateEventError(error)) {
        return;
      }
      throw error;
    }
  }

  /** Which local user a Stripe customer belongs to, or null. Never resolved by email. */
  async findUserByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /**
   * Whether a user id names a real row.
   *
   * Used to check an id read from Stripe Checkout Session metadata before trusting it as a
   * resolution. The metadata was written by this server on a session created for an authenticated
   * user, and forging it would require forging a Stripe signature first — but a stale id from a
   * deleted account must still resolve to nothing rather than to an error deep in reconciliation.
   */
  async userExists(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }

  /** Whether this Stripe event id has already been durably processed. */
  async hasProcessedEvent(stripeEventId: string): Promise<boolean> {
    const existing = await this.prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId },
      select: { id: true },
    });
    return existing !== null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireConfigured(): {
    stripe: StripeGateway;
    catalog: BillingCatalog;
  } {
    if (!this.stripe || !this.catalog) {
      throw new BillingError("Billing is not available", {
        code: "BILLING_NOT_CONFIGURED",
      });
    }
    return { stripe: this.stripe, catalog: this.catalog };
  }

  private async readPlan(userId: string): Promise<UserPlan> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    });
    return user?.plan ?? "FREE";
  }

  /**
   * Which of a customer's subscriptions is *the* subscription.
   *
   * V1 allows one (decision document section 15). Stripe can nonetheless hold several: a canceled
   * one plus a new one is entirely normal, and two live ones is an invariant violation that a
   * Dashboard action or a race could create.
   *
   * The choice is deterministic and conservative:
   *
   * 1. The already-mirrored subscription wins if it is still live. Stability matters more than
   *    recency — flipping the canonical subscription under a user changes their plan.
   * 2. Otherwise the single live one.
   * 3. Otherwise, with several live, the **oldest** by Stripe's `created`. Deterministic across
   *    reconciliations, and it cannot be gamed by starting another subscription. The conflict is
   *    flagged loudly; nothing is merged, nothing is canceled and no refund is issued, because
   *    section 15 says an operator decides that.
   * 4. With none live, the mirrored one if Stripe still has it, else the newest terminal one — so
   *    the UI can say *why* access ended instead of showing nothing.
   */
  private chooseCanonicalSubscription(
    state: StripeCustomerBillingState,
    mirroredSubscriptionId: string | null,
    userId: string,
  ): { subscription: StripeSubscriptionState; conflict: boolean } | null {
    if (state.subscriptions.length === 0) {
      return null;
    }

    const live = state.subscriptions.filter((subscription) =>
      occupiesPaidSlot(toMirroredStatus(subscription.status)),
    );

    if (live.length > 1) {
      this.logger.error({
        event: "billing.invariant.multiple-live-subscriptions",
        actorUserId: userId,
        stripeCustomerId: state.customerId,
        subscriptionCount: live.length,
        subscriptionIds: live.map((subscription) => subscription.id),
        statuses: live.map((subscription) => subscription.status),
      });
    }

    const mirrored = live.find(
      (subscription) => subscription.id === mirroredSubscriptionId,
    );
    if (mirrored) {
      return { subscription: mirrored, conflict: live.length > 1 };
    }

    const oldestLive = [...live].sort(
      (a, b) => a.created.getTime() - b.created.getTime(),
    )[0];
    if (oldestLive) {
      return { subscription: oldestLive, conflict: live.length > 1 };
    }

    const terminalMirrored = state.subscriptions.find(
      (subscription) => subscription.id === mirroredSubscriptionId,
    );
    if (terminalMirrored) {
      return { subscription: terminalMirrored, conflict: false };
    }

    const newest = [...state.subscriptions].sort(
      (a, b) => b.created.getTime() - a.created.getTime(),
    )[0];
    return newest ? { subscription: newest, conflict: false } : null;
  }

  /**
   * What the mirror should say about one Stripe subscription.
   *
   * `plan` and `interval` come from the **current** item price through the configured allowlist.
   * A price outside it leaves both null, which `resolveEffectivePlan` turns into FREE with
   * `PRICE_NOT_IN_CATALOG` — an archived legacy price or another environment's price therefore fails
   * closed, and the mirror still records the price id so an operator can see which one it was.
   *
   * A pending change is mirrored only when the scheduled phase carries a *different* price. Stripe
   * schedules routinely contain a future phase identical to the current one; presenting that as
   * "your plan is changing" would be wrong.
   */
  private describeMirror(
    subscription: StripeSubscriptionState,
    state: StripeCustomerBillingState,
    catalog: BillingCatalog,
  ): DesiredMirror {
    const current = catalog.resolvePriceId(subscription.currentPriceId);
    const phase = state.scheduledPhases[subscription.id] ?? null;
    const pending = phase ? catalog.resolvePriceId(phase.priceId) : null;
    const pendingIsRealChange =
      phase !== null && phase.priceId !== subscription.currentPriceId;

    return {
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.currentPriceId ?? "",
      plan: current?.plan ?? null,
      billingInterval: current?.interval ?? null,
      status: toMirroredStatus(subscription.status),
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      cancelAt: subscription.cancelAt,
      canceledAt: subscription.canceledAt,
      pendingPlan: pendingIsRealChange ? (pending?.plan ?? null) : null,
      pendingInterval: pendingIsRealChange ? (pending?.interval ?? null) : null,
      pendingPriceId: pendingIsRealChange ? (phase?.priceId ?? null) : null,
      pendingEffectiveAt: pendingIsRealChange ? (phase?.startsAt ?? null) : null,
      stripeScheduleId: subscription.scheduleId,
    };
  }

  /**
   * One structured line per reconciliation, carrying everything a support query needs.
   *
   * "Why is user X currently FREE/STARTER/PRO?" is answerable from this alone: who, what changed,
   * which status and price reason produced it, and what triggered the decision.
   */
  private logReconciliation(
    trigger: ReconciliationTrigger,
    result: ReconciliationResult,
    durationMs: number,
  ): void {
    const fields = {
      event: "billing.reconciliation.completed",
      actorUserId: result.userId,
      trigger,
      outcome: result.outcome,
      previousPlan: result.previousPlan,
      plan: result.plan,
      planChanged: result.planChanged,
      planReason: result.planReason,
      subscriptionStatus: result.subscriptionStatus,
      durationMs,
    };

    if (result.anomalous) {
      this.logger.warn({ ...fields, anomalous: true });
      return;
    }
    if (result.planChanged) {
      this.logger.info(fields);
      return;
    }
    this.logger.debug(fields);
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function toPersistedPlan(plan: UserPlan | null): PersistedPlan | null {
  return plan === null ? null : PersistedPlan[plan];
}

function toPersistedInterval(
  interval: BillingInterval | null,
): PersistedInterval | null {
  return interval === null ? null : PersistedInterval[interval];
}

/**
 * Whether this failure is the unique-constraint collision on `stripeEventId`.
 *
 * That collision *is* the duplicate-delivery detector: two deliveries of one event serialize on the
 * user's advisory lock, the first commits its marker, and the second's insert cannot land. Matching
 * on the target keeps an unrelated unique violation from being mistaken for a duplicate webhook.
 */
function isDuplicateEventError(error: unknown): boolean {
  const known = error as Prisma.PrismaClientKnownRequestError | undefined;
  if (known?.code !== "P2002") {
    return false;
  }
  const target = known.meta?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return fields.includes("stripeEventId");
}
