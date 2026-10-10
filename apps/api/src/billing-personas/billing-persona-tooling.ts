import { randomUUID } from "node:crypto";
import type {
  BillingInterval,
  BillingSubscriptionStatus,
  UserPlan,
} from "@intrinsic/contracts";
import { UserRole, type PrismaClient } from "@intrinsic/database";
import {
  BILLING_PERSONA_LIST,
  acceptCurrentTermsForTestUsers,
  type BillingPersona,
  type BillingPersonaName,
} from "@intrinsic/testing";
import type { BillingCatalog } from "../billing/billing-catalog";
import type { BillingReconciliationService } from "../billing/billing-reconciliation.service";
import { hasScheduledCancellation } from "../billing/stripe-gateway";
import type {
  StripeFixtureClock,
  StripeFixtureCustomer,
  StripeFixtureGateway,
  StripeFixtureSubscription,
} from "../billing/stripe-fixture-gateway";
import {
  billingPersonaClockName,
  billingPersonaFixtureMetadata,
  claimsBillingPersonaClockName,
  classifyBillingPersonaFixture,
  evaluateBillingPersonaFixture,
  parseBillingPersonaClockName,
  planFixtureCleanup,
  type AmbiguousBillingPersonaFixture,
  type BillingPersonaFixtureIdentity,
  type ObservedFixtureClock,
  type OwnedBillingPersonaFixture,
} from "./billing-persona-fixtures";

/**
 * Seeds, inspects and removes the billing QA personas.
 *
 * The division of labour is the whole design, so it is stated once here:
 *
 * ```text
 * this module          real Stripe test mode             the application
 * -----------          ---------------------             ---------------
 * the account row  ->  Test Clock, customer,         ->  BillingReconciliationService
 * and its customer     subscription, lifecycle           writes BillingSubscription
 * link                                                   and User.plan
 * ```
 *
 * **What this module writes in PostgreSQL** is exactly two things, both identity rather than
 * billing state: the persona's `User` row (address, verification, role, optionally a password) with
 * its Terms acceptance, and `User.stripeCustomerId` — the link `ai/architecture/billing.md` already
 * prescribes for a Test Clock customer, since such a customer cannot arrive through Checkout.
 *
 * **What it never writes**: a `BillingSubscription` row, or `User.plan`. Every mirror and every plan
 * a billing persona holds was produced by `reconcileUser` reading Stripe — the same function, lock
 * and transaction a webhook uses. Removing a persona's billing state goes the same way: the link is
 * cleared and reconciliation, finding no customer, takes the mirror away and the plan to `FREE`.
 * `billing-persona-boundary.test.ts` holds this file to that.
 *
 * It also decides nothing about plans. What a persona *should* resolve to is a literal in the
 * registry (`@intrinsic/testing`), compared against what reconciliation actually produced.
 */

/** How long things take. Injected so the deterministic suite does not wait on real time. */
export type BillingPersonaTiming = {
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** How often a Test Clock is polled while it advances. */
  readonly clockPollIntervalMs: number;
  /** How long one advancement may take before the run gives up. */
  readonly clockTimeoutMs: number;
};

export const DEFAULT_BILLING_PERSONA_TIMING: BillingPersonaTiming = {
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clockPollIntervalMs: 2_000,
  clockTimeoutMs: 5 * 60_000,
};

export type BillingPersonaTooling = {
  readonly prisma: PrismaClient;
  readonly fixtures: StripeFixtureGateway;
  readonly catalog: BillingCatalog;
  /** The application's real reconciliation service — never a stand-in for its rules. */
  readonly reconciliation: Pick<BillingReconciliationService, "reconcileUser">;
  readonly hashPassword: (password: string) => Promise<string>;
  /** Progress for the operator. Never receives a credential. */
  readonly report: (line: string) => void;
  readonly timing: BillingPersonaTiming;
  /** Written onto every fixture as `factorsage_qa_created_by`. */
  readonly createdBy: string;
};

/** The tooling declined to act because acting would not be provably safe. */
export class BillingPersonaRefusedError extends Error {
  override readonly name = "BillingPersonaRefusedError";
}

/** Stripe did not reach the state a persona declares. */
export class BillingPersonaFixtureError extends Error {
  override readonly name = "BillingPersonaFixtureError";
}

/**
 * How far past the period end a clock is first advanced.
 *
 * Stripe creates a renewal invoice at the period end as a draft, finalises it about an hour later,
 * and only then attempts the charge — so "the period ended" and "the payment failed" are an hour
 * apart, and a clock stopped exactly on the boundary shows a subscription that is still `active`.
 */
const BOUNDARY_MARGIN_MS = 2 * 60 * 60 * 1000;

/** If the state has not arrived, how much further each additional advance goes, and how many. */
const BOUNDARY_RETRY_STEP_MS = 60 * 60 * 1000;
const BOUNDARY_MAX_RETRIES = 4;

/**
 * Where a lifecycle that needs the period end to arrive starts its clock.
 *
 * Far enough in the past that a month later is still before today. The subscription then reads as
 * one that began last month and whose renewal failed, or whose paid period ended, a few days ago —
 * rather than as one whose key dates are weeks in the future.
 */
const BOUNDARY_LIFECYCLE_BACKDATE_MS = 35 * 86_400_000;

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * Creates or repairs the persona's account, and writes nothing about billing.
 *
 * There is no `plan` in either branch: a new row takes the column's own default and an existing
 * row keeps whatever reconciliation last gave it. The role is re-asserted as `USER` — a billing
 * persona is a customer, never an administrator — and the password only when one was supplied.
 */
export async function ensureBillingPersonaAccount(
  tooling: Pick<BillingPersonaTooling, "prisma" | "hashPassword" | "timing">,
  persona: BillingPersona,
  password: string | null,
): Promise<{ readonly userId: string; readonly created: boolean }> {
  const { prisma } = tooling;
  const passwordHash =
    password === null ? null : await tooling.hashPassword(password);
  const existing = await prisma.user.findUnique({
    where: { email: persona.email },
    select: { id: true, emailVerifiedAt: true },
  });

  let userId: string;
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: UserRole.USER,
        ...(existing.emailVerifiedAt
          ? {}
          : { emailVerifiedAt: tooling.timing.now() }),
        ...(passwordHash === null ? {} : { passwordHash }),
      },
    });
    userId = existing.id;
  } else {
    const created = await prisma.user.create({
      data: {
        email: persona.email,
        emailVerifiedAt: tooling.timing.now(),
        role: UserRole.USER,
        ...(passwordHash === null ? {} : { passwordHash }),
      },
      select: { id: true },
    });
    userId = created.id;
  }

  // Otherwise every surface but the acceptance screen answers 403 (`@intrinsic/testing`).
  await acceptCurrentTermsForTestUsers(prisma, [userId]);
  return { userId, created: !existing };
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

type ClassifiedFixture =
  OwnedBillingPersonaFixture | AmbiguousBillingPersonaFixture;

async function observeClock(
  fixtures: StripeFixtureGateway,
  clock: StripeFixtureClock,
): Promise<ObservedFixtureClock> {
  const customers = await fixtures.listTestClockCustomers(clock.id);
  return {
    clock,
    customers: await Promise.all(
      customers.map(async (customer) => ({
        customer,
        subscriptions: await fixtures.listSubscriptions(customer.id),
      })),
    ),
  };
}

/**
 * Every Test Clock in the account that claims to be a billing persona fixture, classified.
 *
 * A clock whose name is not ours is skipped before anything on it is read: this tooling has no
 * business listing the customers of somebody else's test data. With `only`, a clock whose name
 * cleanly states a *different* persona or owner is skipped the same way — it is another fixture's,
 * and reading it would tell this one nothing.
 */
export async function observeBillingPersonaFixtures(
  fixtures: StripeFixtureGateway,
  only?: BillingPersonaFixtureIdentity,
): Promise<readonly ClassifiedFixture[]> {
  const classified: ClassifiedFixture[] = [];
  for (const clock of await fixtures.listTestClocks()) {
    if (!claimsBillingPersonaClockName(clock.name)) {
      continue;
    }
    const named = parseBillingPersonaClockName(clock.name);
    if (only && named !== null && !sameIdentity(named, only)) {
      continue;
    }
    const classification = classifyBillingPersonaFixture(
      await observeClock(fixtures, clock),
    );
    if (classification.kind !== "FOREIGN") {
      classified.push(classification);
    }
  }
  return classified;
}

function sameIdentity(
  left: BillingPersonaFixtureIdentity | null,
  right: BillingPersonaFixtureIdentity,
): boolean {
  return (
    left !== null &&
    left.persona === right.persona &&
    left.ownerUserId === right.ownerUserId
  );
}

function describeRefusal(fixture: AmbiguousBillingPersonaFixture): string {
  return `test clock ${fixture.clock.id} (${fixture.clock.name ?? "unnamed"}): ${fixture.reasons.join("; ")}`;
}

// ---------------------------------------------------------------------------
// The customer link, and reconciliation
// ---------------------------------------------------------------------------

/** Points the account at its fixture customer. Returns whether anything changed. */
async function linkCustomer(
  tooling: BillingPersonaTooling,
  userId: string,
  customerId: string,
): Promise<boolean> {
  const user = await tooling.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (user.stripeCustomerId === customerId) {
    return false;
  }
  await tooling.prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customerId },
  });
  return true;
}

/**
 * Removes an account's billing state the way the application removes it.
 *
 * Only the link is cleared here. `reconcileUser` then finds a user with no customer, deletes the
 * mirror and moves the plan to `FREE` through the one plan write path. It happens **before** the
 * Stripe customer is deleted, so the account never points at a customer Stripe no longer has.
 * Stripe cancels the subscription of a customer it deletes and goes on listing it, so such an
 * account would still reconcile to `FREE` — but with its link, and a `CANCELED` mirror, left
 * describing a customer that no longer exists.
 */
async function detachUser(
  tooling: BillingPersonaTooling,
  userId: string,
): Promise<void> {
  await tooling.prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: null },
  });
  await tooling.reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
}

async function detachCustomer(
  tooling: BillingPersonaTooling,
  customerId: string,
): Promise<string | null> {
  const linked = await tooling.prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true, email: true },
  });
  if (!linked) {
    return null;
  }
  await detachUser(tooling, linked.id);
  return linked.email;
}

// ---------------------------------------------------------------------------
// Test Clocks
// ---------------------------------------------------------------------------

/**
 * Waits until Stripe reports a clock `ready`.
 *
 * Advancing is asynchronous on Stripe's side: the call returns at once with the clock `advancing`,
 * and the renewals, invoices and status changes it causes land while it stays that way. Reading a
 * subscription before the clock is `ready` reads a state that is still moving.
 */
async function waitForClockReady(
  tooling: BillingPersonaTooling,
  clockId: string,
): Promise<void> {
  const { timing } = tooling;
  const deadline = timing.now().getTime() + timing.clockTimeoutMs;
  for (;;) {
    const clock = await tooling.fixtures.retrieveTestClock(clockId);
    if (clock === null) {
      throw new BillingPersonaFixtureError(
        `Test clock ${clockId} disappeared while it was advancing.`,
      );
    }
    if (clock.status === "ready") {
      return;
    }
    if (clock.status !== "advancing") {
      throw new BillingPersonaFixtureError(
        `Test clock ${clockId} is ${clock.status}; Stripe could not advance it.`,
      );
    }
    if (timing.now().getTime() >= deadline) {
      throw new BillingPersonaFixtureError(
        `Test clock ${clockId} was still advancing after ` +
          `${Math.round(timing.clockTimeoutMs / 1000)} s.`,
      );
    }
    await timing.sleep(timing.clockPollIntervalMs);
  }
}

async function requireSubscription(
  tooling: BillingPersonaTooling,
  customerId: string,
  subscriptionId: string,
): Promise<StripeFixtureSubscription> {
  const subscription = (
    await tooling.fixtures.listSubscriptions(customerId)
  ).find((candidate) => candidate.id === subscriptionId);
  if (!subscription) {
    throw new BillingPersonaFixtureError(
      `Subscription ${subscriptionId} is no longer listed for its customer.`,
    );
  }
  return subscription;
}

/**
 * Advances a clock over a period boundary until the subscription reaches the wanted status.
 *
 * Bounded: a first advance past the boundary, then a few further hours if Stripe has not acted
 * yet. Any status other than the wanted one or `active` means the lifecycle went somewhere this
 * persona does not describe, and that is a failure rather than something to advance through.
 */
async function advanceOverBoundary(
  tooling: BillingPersonaTooling,
  input: {
    readonly clockId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly boundary: Date;
    readonly wanted: "past_due" | "canceled";
    readonly idempotencyKey: (step: string) => string;
  },
): Promise<StripeFixtureSubscription> {
  let target = new Date(input.boundary.getTime() + BOUNDARY_MARGIN_MS);
  for (let attempt = 0; attempt <= BOUNDARY_MAX_RETRIES; attempt += 1) {
    tooling.report(`    advancing the test clock to ${target.toISOString()}`);
    await tooling.fixtures.advanceTestClock({
      clockId: input.clockId,
      frozenTime: target,
      idempotencyKey: input.idempotencyKey(`advance-${attempt}`),
    });
    await waitForClockReady(tooling, input.clockId);

    const subscription = await requireSubscription(
      tooling,
      input.customerId,
      input.subscriptionId,
    );
    if (subscription.status === input.wanted) {
      return subscription;
    }
    if (subscription.status !== "active") {
      throw new BillingPersonaFixtureError(
        `The subscription became ${subscription.status} instead of ${input.wanted}.`,
      );
    }
    target = new Date(target.getTime() + BOUNDARY_RETRY_STEP_MS);
  }
  throw new BillingPersonaFixtureError(
    `The subscription was still active ${BOUNDARY_MAX_RETRIES + 1} advances past its period ` +
      `end; Stripe never moved it to ${input.wanted}.`,
  );
}

// ---------------------------------------------------------------------------
// Building and removing a fixture
// ---------------------------------------------------------------------------

function requireActive(
  subscription: StripeFixtureSubscription,
  when: string,
): void {
  if (subscription.status !== "active") {
    throw new BillingPersonaFixtureError(
      `The subscription is ${subscription.status} ${when}; it should be active.`,
    );
  }
}

function requirePeriodEnd(subscription: StripeFixtureSubscription): Date {
  if (subscription.currentPeriodEnd === null) {
    throw new BillingPersonaFixtureError(
      "Stripe reported no current period end for the subscription.",
    );
  }
  return subscription.currentPeriodEnd;
}

/**
 * Builds one persona's Stripe state from nothing.
 *
 * ## Idempotency keys
 *
 * Every create and every advance carries one, of the form
 * `factorsage-qa:billing-persona:<persona>:<user>:<attempt>:<step>`. The `<attempt>` is new for
 * each build, deliberately. A key that was stable across builds would make the *second* build of a
 * persona replay the first one's responses for the 24 hours Stripe remembers a key — handing back
 * the id of a clock that has since been deleted. What stops an interrupted run from leaving
 * duplicates is therefore not the key but the fixture's name: the next run finds the half-built
 * clock by it and removes it before building again. The key covers what is left: a retried request
 * inside one build.
 */
async function buildFixture(
  tooling: BillingPersonaTooling,
  persona: BillingPersona,
  identity: BillingPersonaFixtureIdentity,
  priceId: string,
): Promise<{
  readonly customer: StripeFixtureCustomer;
  readonly subscription: StripeFixtureSubscription;
}> {
  const { fixtures, timing } = tooling;
  const attempt = randomUUID();
  const idempotencyKey = (step: string): string =>
    `factorsage-qa:billing-persona:${identity.persona}:${identity.ownerUserId}:${attempt}:${step}`;
  const metadata = billingPersonaFixtureMetadata(identity, tooling.createdBy);

  const crossesBoundary =
    persona.lifecycle === "PAST_DUE" || persona.lifecycle === "CANCELED";
  const startsAt = new Date(
    timing.now().getTime() -
      (crossesBoundary ? BOUNDARY_LIFECYCLE_BACKDATE_MS : 0),
  );

  tooling.report(`    creating a test clock at ${startsAt.toISOString()}`);
  const clock = await fixtures.createTestClock({
    name: billingPersonaClockName(identity),
    frozenTime: startsAt,
    idempotencyKey: idempotencyKey("clock"),
  });
  const customer = await fixtures.createTestClockCustomer({
    clockId: clock.id,
    email: persona.email,
    name: `FactorSage QA ${persona.name}`,
    metadata,
    idempotencyKey: idempotencyKey("customer"),
  });

  // Linked before the subscription exists. Where a webhook listener is forwarding this sandbox's
  // events, every lifecycle event that follows then resolves to this account and is reconciled
  // through the real webhook path, rather than being recorded as an unknown customer.
  await linkCustomer(tooling, identity.ownerUserId, customer.id);

  const paymentMethod = await fixtures.attachTestPaymentMethod({
    customerId: customer.id,
    behavior: "SUCCEEDS",
    metadata,
    idempotencyKey: idempotencyKey("payment-method"),
  });
  tooling.report(`    subscribing to ${persona.priceKey}`);
  let subscription = await fixtures.createSubscription({
    customerId: customer.id,
    priceId,
    paymentMethodId: paymentMethod.id,
    metadata,
    idempotencyKey: idempotencyKey("subscription"),
  });
  requireActive(subscription, "after its first payment");

  switch (persona.lifecycle) {
    case "ACTIVE":
      break;
    case "CANCELING":
      tooling.report("    scheduling cancellation at the end of the period");
      subscription = await fixtures.scheduleCancellationAtPeriodEnd(
        subscription.id,
      );
      break;
    case "PAST_DUE": {
      tooling.report("    replacing the payment method with one that fails");
      const failing = await fixtures.attachTestPaymentMethod({
        customerId: customer.id,
        behavior: "FAILS_ON_CHARGE",
        metadata,
        idempotencyKey: idempotencyKey("failing-payment-method"),
      });
      await fixtures.setSubscriptionPaymentMethod({
        subscriptionId: subscription.id,
        paymentMethodId: failing.id,
      });
      subscription = await advanceOverBoundary(tooling, {
        clockId: clock.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        boundary: requirePeriodEnd(subscription),
        wanted: "past_due",
        idempotencyKey,
      });
      break;
    }
    case "CANCELED": {
      tooling.report("    scheduling cancellation at the end of the period");
      subscription = await fixtures.scheduleCancellationAtPeriodEnd(
        subscription.id,
      );
      subscription = await advanceOverBoundary(tooling, {
        clockId: clock.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        boundary: subscription.cancelAt ?? requirePeriodEnd(subscription),
        wanted: "canceled",
        idempotencyKey,
      });
      break;
    }
  }

  // Judged by the rule a rerun will judge it by, on what Stripe holds now rather than on the
  // objects the calls above returned.
  const settled = await fixtures.retrieveTestClock(clock.id);
  const classification =
    settled === null
      ? null
      : classifyBillingPersonaFixture(await observeClock(fixtures, settled));
  if (classification?.kind !== "OWNED") {
    throw new BillingPersonaFixtureError(
      "The fixture that was just built is not recognisable as this tooling's own.",
    );
  }
  const evaluation = evaluateBillingPersonaFixture({
    persona,
    priceId,
    fixture: classification,
  });
  if (!evaluation.converged) {
    throw new BillingPersonaFixtureError(
      `Stripe did not reach ${persona.name}'s declared state: ${evaluation.reasons.join("; ")}.`,
    );
  }
  return {
    customer: evaluation.customer,
    subscription: evaluation.subscription,
  };
}

/**
 * Deletes one fixture, after proving once more that it is ours.
 *
 * The fixture is re-read and re-classified immediately before the delete, so the decision rests on
 * what Stripe holds at that moment and not on a listing made earlier in the run. Anything that no
 * longer reads as fully owned by the same identity is refused.
 */
async function deleteOwnedFixture(
  tooling: BillingPersonaTooling,
  fixture: OwnedBillingPersonaFixture,
): Promise<{ readonly detached: string | null }> {
  const clock = await tooling.fixtures.retrieveTestClock(fixture.clock.id);
  if (clock === null) {
    return { detached: null };
  }
  const current = classifyBillingPersonaFixture(
    await observeClock(tooling.fixtures, clock),
  );
  if (
    current.kind !== "OWNED" ||
    !sameIdentity(current.identity, fixture.identity)
  ) {
    throw new BillingPersonaRefusedError(
      `Refusing to delete test clock ${fixture.clock.id}: it no longer reads as this tooling's ` +
        "fixture" +
        (current.kind === "AMBIGUOUS"
          ? ` (${current.reasons.join("; ")})`
          : "") +
        ".",
    );
  }

  const detached = current.customer
    ? await detachCustomer(tooling, current.customer.id)
    : null;
  if (current.clock.status === "advancing") {
    await waitForClockReady(tooling, current.clock.id);
  }
  await tooling.fixtures.deleteTestClock(current.clock.id);
  return { detached };
}

// ---------------------------------------------------------------------------
// FactorSage's side
// ---------------------------------------------------------------------------

export type BillingPersonaLocalState = {
  readonly userId: string;
  readonly plan: UserPlan;
  readonly stripeCustomerId: string | null;
  readonly mirror: {
    readonly stripeSubscriptionId: string;
    readonly stripePriceId: string;
    readonly plan: UserPlan | null;
    readonly billingInterval: BillingInterval | null;
    readonly status: BillingSubscriptionStatus;
    readonly currentPeriodEnd: Date | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly cancelAt: Date | null;
    readonly canceledAt: Date | null;
    readonly planReason: string;
    readonly syncedAt: Date;
  } | null;
};

async function readLocalState(
  prisma: PrismaClient,
  userId: string,
): Promise<BillingPersonaLocalState> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, stripeCustomerId: true },
  });
  const mirror = await prisma.billingSubscription.findUnique({
    where: { userId },
    select: {
      stripeSubscriptionId: true,
      stripePriceId: true,
      plan: true,
      billingInterval: true,
      status: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      cancelAt: true,
      canceledAt: true,
      planReason: true,
      syncedAt: true,
    },
  });
  return {
    userId,
    plan: user.plan,
    stripeCustomerId: user.stripeCustomerId,
    mirror,
  };
}

/**
 * Where FactorSage's persisted state differs from what the persona declares. Empty when it agrees.
 *
 * Every right-hand side is a literal from the registry or an id read from Stripe. Nothing here
 * works out what a status *should* mean — that is `resolveEffectivePlan`'s job, done inside
 * reconciliation, and this only checks the answer.
 */
export function billingPersonaLocalProblems(input: {
  readonly persona: BillingPersona;
  readonly local: BillingPersonaLocalState;
  readonly priceId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
}): string[] {
  const { persona, local } = input;
  const { expected } = persona;
  const problems: string[] = [];

  if (local.plan !== expected.userPlan) {
    problems.push(`User.plan is ${local.plan}, expected ${expected.userPlan}`);
  }
  if (local.stripeCustomerId !== input.customerId) {
    problems.push("the account is not linked to the fixture's Stripe customer");
  }

  const mirror = local.mirror;
  if (mirror === null) {
    problems.push("there is no BillingSubscription mirror");
    return problems;
  }
  if (mirror.stripeSubscriptionId !== input.subscriptionId) {
    problems.push("the mirror describes a different Stripe subscription");
  }
  if (mirror.stripePriceId !== input.priceId) {
    problems.push(
      `the mirror is not on the configured ${persona.priceKey} price`,
    );
  }
  if (mirror.status !== expected.mirrorStatus) {
    problems.push(
      `the mirror's status is ${mirror.status}, expected ${expected.mirrorStatus}`,
    );
  }
  if (mirror.plan !== persona.subscribedPlan) {
    problems.push(
      `the mirror's plan is ${mirror.plan ?? "unresolved"}, expected ${persona.subscribedPlan}`,
    );
  }
  if (mirror.billingInterval !== persona.interval) {
    problems.push(
      `the mirror's interval is ${mirror.billingInterval ?? "unresolved"}, expected ${persona.interval}`,
    );
  }
  if (mirror.planReason !== expected.planReason) {
    problems.push(
      `the mirror's plan reason is ${mirror.planReason}, expected ${expected.planReason}`,
    );
  }
  if (expected.holdsPaidSlot) {
    if (mirror.cancelAtPeriodEnd !== expected.cancellationScheduled) {
      problems.push(
        expected.cancellationScheduled
          ? "the mirror records no scheduled cancellation"
          : "the mirror records a scheduled cancellation",
      );
    }
    if (expected.cancellationScheduled && mirror.cancelAt === null) {
      problems.push("the mirror has no cancellation date");
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export type BillingPersonaSeedResult = {
  readonly persona: BillingPersonaName;
  readonly userId: string;
  /**
   * What the run did in Stripe: left a converged fixture alone, built the first one, or removed a
   * stale or half-built one and built again.
   */
  readonly stripe: "REUSED" | "CREATED" | "REBUILT";
  /** Why an existing fixture was not reused. Empty unless `stripe` is `REBUILT`. */
  readonly rebuildReasons: readonly string[];
  readonly customerId: string;
  readonly subscription: StripeFixtureSubscription;
  readonly local: BillingPersonaLocalState;
  /** Where FactorSage's reconciled state differs from the declared one. Empty on success. */
  readonly problems: readonly string[];
};

/**
 * Makes one billing persona true: in Stripe, then — through reconciliation — in FactorSage.
 *
 * Convergent rather than additive. A fixture that already is the declared state is left exactly as
 * it is and the run makes no Stripe write at all; anything else that belongs to this persona — a
 * fixture a previous run abandoned half-built, one that drifted, more than one — is removed first,
 * so no number of interrupted runs can accumulate customers or subscriptions. Reconciliation runs
 * every time, which also repairs a mirror or a plan that was changed by hand.
 */
export async function seedBillingPersona(
  tooling: BillingPersonaTooling,
  persona: BillingPersona,
  options: { readonly password: string | null },
): Promise<BillingPersonaSeedResult> {
  const price = tooling.catalog.resolveKey(persona.priceKey);
  const account = await ensureBillingPersonaAccount(
    tooling,
    persona,
    options.password,
  );
  const identity: BillingPersonaFixtureIdentity = {
    persona: persona.name,
    ownerUserId: account.userId,
  };

  let mine = await fixturesOf(tooling, identity);
  // A previous run may have stopped while a clock was still advancing. Let it finish, then look
  // again: the lifecycle it was driving may well have arrived.
  const advancing = mine.filter(
    (fixture) => fixture.clock.status === "advancing",
  );
  if (advancing.length > 0) {
    for (const fixture of advancing) {
      await waitForClockReady(tooling, fixture.clock.id);
    }
    mine = await fixturesOf(tooling, identity);
  }

  await assertNotLinkedElsewhere(tooling, persona, account.userId, mine);

  const only = mine.length === 1 ? mine[0] : undefined;
  const evaluation = only
    ? evaluateBillingPersonaFixture({
        persona,
        priceId: price.priceId,
        fixture: only,
      })
    : null;

  let stripe: BillingPersonaSeedResult["stripe"];
  let rebuildReasons: readonly string[] = [];
  let customer: StripeFixtureCustomer;
  let subscription: StripeFixtureSubscription;

  if (evaluation?.converged) {
    stripe = "REUSED";
    ({ customer, subscription } = evaluation);
  } else {
    if (mine.length > 0) {
      stripe = "REBUILT";
      rebuildReasons =
        evaluation && !evaluation.converged
          ? evaluation.reasons
          : [
              `${mine.length} fixtures exist for this persona; there must be one`,
            ];
      tooling.report(
        `    removing the existing fixture: ${rebuildReasons.join("; ")}`,
      );
      for (const fixture of mine) {
        await deleteOwnedFixture(tooling, fixture);
      }
    } else {
      stripe = "CREATED";
    }
    ({ customer, subscription } = await buildFixture(
      tooling,
      persona,
      identity,
      price.priceId,
    ));
  }

  await linkCustomer(tooling, account.userId, customer.id);
  // The one place a billing persona's mirror and plan come from.
  await tooling.reconciliation.reconcileUser({
    userId: account.userId,
    trigger: "MANUAL",
  });

  const local = await readLocalState(tooling.prisma, account.userId);
  return {
    persona: persona.name,
    userId: account.userId,
    stripe,
    rebuildReasons,
    customerId: customer.id,
    subscription,
    local,
    problems: billingPersonaLocalProblems({
      persona,
      local,
      priceId: price.priceId,
      customerId: customer.id,
      subscriptionId: subscription.id,
    }),
  };
}

/** This identity's own fixtures, after refusing anything ambiguous that claims to be one. */
async function fixturesOf(
  tooling: BillingPersonaTooling,
  identity: BillingPersonaFixtureIdentity,
): Promise<readonly OwnedBillingPersonaFixture[]> {
  const observed = await observeBillingPersonaFixtures(
    tooling.fixtures,
    identity,
  );
  const ambiguous = observed.filter(
    (fixture): fixture is AmbiguousBillingPersonaFixture =>
      fixture.kind === "AMBIGUOUS" && sameIdentity(fixture.claimed, identity),
  );
  if (ambiguous.length > 0) {
    throw new BillingPersonaRefusedError(
      `Refusing to seed ${identity.persona}: a Stripe test clock claims to be its fixture but is ` +
        `not consistently tagged, so it is neither reused nor replaced. ` +
        `${ambiguous.map(describeRefusal).join(" | ")}. Inspect it in the Stripe Dashboard and ` +
        "delete it there if it is safe to remove.",
    );
  }
  return observed.filter(
    (fixture): fixture is OwnedBillingPersonaFixture =>
      fixture.kind === "OWNED" && sameIdentity(fixture.identity, identity),
  );
}

/**
 * Refuses when the account is linked to a live Stripe customer this tooling did not create.
 *
 * That is what a billing persona driven through real Checkout by hand looks like. Re-pointing the
 * link would orphan that customer and whatever it is subscribed to, so it is left for a person. A
 * link to a customer Stripe no longer has is different: it is what an expired Test Clock leaves
 * behind, and replacing it is the repair.
 */
async function assertNotLinkedElsewhere(
  tooling: BillingPersonaTooling,
  persona: BillingPersona,
  userId: string,
  mine: readonly OwnedBillingPersonaFixture[],
): Promise<void> {
  const user = await tooling.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  const linked = user.stripeCustomerId;
  if (
    linked === null ||
    mine.some((fixture) => fixture.customer?.id === linked)
  ) {
    return;
  }
  if ((await tooling.fixtures.retrieveCustomer(linked)) === null) {
    return;
  }
  throw new BillingPersonaRefusedError(
    `Refusing to seed ${persona.name}: ${persona.email} is linked to Stripe customer ${linked}, ` +
      "which is not one of this tooling's fixtures. Remove that customer in the Stripe " +
      "Dashboard, or clear the link, and run the seed again.",
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const BILLING_PERSONA_VERDICTS = [
  /** Stripe holds the declared state and FactorSage's reconciled state agrees with it. */
  "CONVERGED",
  /** Nothing has been seeded for this persona in this database. */
  "NOT_SEEDED",
  /** A fixture exists but is not the declared Stripe state. `seed` rebuilds it. */
  "STRIPE_DRIFT",
  /** Stripe is right and FactorSage's mirror or plan is not. `seed` reconciles it. */
  "LOCAL_DRIFT",
  /** The account points at a Stripe customer that no longer exists. `seed` or `cleanup` repairs it. */
  "STALE_LINK",
  /** Something claims to be this persona's fixture and is not consistent. Needs a person. */
  "AMBIGUOUS",
] as const;

export type BillingPersonaVerdict = (typeof BILLING_PERSONA_VERDICTS)[number];

export type BillingPersonaStatus = {
  readonly persona: BillingPersona;
  readonly verdict: BillingPersonaVerdict;
  readonly problems: readonly string[];
  readonly local: BillingPersonaLocalState | null;
  readonly fixture: OwnedBillingPersonaFixture | null;
};

/** Reports one persona's Stripe fixture and FactorSage state. Reads only; reconciles nothing. */
export async function inspectBillingPersona(
  tooling: BillingPersonaTooling,
  persona: BillingPersona,
  observed?: readonly ClassifiedFixture[],
): Promise<BillingPersonaStatus> {
  const user = await tooling.prisma.user.findUnique({
    where: { email: persona.email },
    select: { id: true },
  });
  if (!user) {
    return {
      persona,
      verdict: "NOT_SEEDED",
      problems: ["the account does not exist"],
      local: null,
      fixture: null,
    };
  }

  const local = await readLocalState(tooling.prisma, user.id);
  const identity = { persona: persona.name, ownerUserId: user.id };
  const all =
    observed ?? (await observeBillingPersonaFixtures(tooling.fixtures));

  const ambiguous = all.filter(
    (fixture): fixture is AmbiguousBillingPersonaFixture =>
      fixture.kind === "AMBIGUOUS" && sameIdentity(fixture.claimed, identity),
  );
  if (ambiguous.length > 0) {
    return {
      persona,
      verdict: "AMBIGUOUS",
      problems: ambiguous.map(describeRefusal),
      local,
      fixture: null,
    };
  }

  const mine = all.filter(
    (fixture): fixture is OwnedBillingPersonaFixture =>
      fixture.kind === "OWNED" && sameIdentity(fixture.identity, identity),
  );
  const only = mine[0];
  if (only === undefined) {
    if (local.stripeCustomerId === null) {
      return {
        persona,
        verdict: "NOT_SEEDED",
        problems: ["no Stripe fixture exists"],
        local,
        fixture: null,
      };
    }
    const linked = await tooling.fixtures.retrieveCustomer(
      local.stripeCustomerId,
    );
    return linked === null
      ? {
          persona,
          verdict: "STALE_LINK",
          problems: [
            "the linked Stripe customer no longer exists (Stripe deletes a Test Clock, and " +
              "everything on it, about 30 days after it was created)",
          ],
          local,
          fixture: null,
        }
      : {
          persona,
          verdict: "AMBIGUOUS",
          problems: [
            `the account is linked to Stripe customer ${linked.id}, which is not one of this ` +
              "tooling's fixtures",
          ],
          local,
          fixture: null,
        };
  }
  if (mine.length > 1) {
    return {
      persona,
      verdict: "STRIPE_DRIFT",
      problems: [
        `${mine.length} fixtures exist for this persona; there must be one`,
      ],
      local,
      fixture: only,
    };
  }

  const price = tooling.catalog.resolveKey(persona.priceKey);
  const evaluation = evaluateBillingPersonaFixture({
    persona,
    priceId: price.priceId,
    fixture: only,
  });
  if (!evaluation.converged) {
    return {
      persona,
      verdict: "STRIPE_DRIFT",
      problems: evaluation.reasons,
      local,
      fixture: only,
    };
  }

  const problems = billingPersonaLocalProblems({
    persona,
    local,
    priceId: price.priceId,
    customerId: evaluation.customer.id,
    subscriptionId: evaluation.subscription.id,
  });
  return {
    persona,
    verdict: problems.length === 0 ? "CONVERGED" : "LOCAL_DRIFT",
    problems,
    local,
    fixture: only,
  };
}

/**
 * A subscription's cancellation as Stripe represents it, for the operator.
 *
 * The two raw fields are printed rather than a summary, because which of Stripe's two
 * representations came back is exactly what somebody reading this wants to know.
 */
export function describeCancellation(
  subscription: StripeFixtureSubscription,
): string {
  if (!hasScheduledCancellation(subscription)) {
    return "none";
  }
  return (
    `${subscription.status === "canceled" ? "took effect" : "scheduled"} ` +
    `(cancel_at=${subscription.cancelAt?.toISOString() ?? "null"}, ` +
    `cancel_at_period_end=${subscription.cancelAtPeriodEnd})`
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export type BillingPersonaCleanupScope =
  /** The fixtures of this database's billing persona accounts. The default. */
  | "DATABASE"
  /** Every fixture this tooling created in the Stripe account, whoever it belongs to. */
  | "ALL_TAGGED";

export type BillingPersonaCleanupResult = {
  readonly dryRun: boolean;
  /** Fixtures deleted, or that would be. */
  readonly fixtures: readonly {
    readonly clockId: string;
    readonly persona: string;
    readonly ownerUserId: string;
    readonly customerId: string | null;
  }[];
  /** Accounts whose link pointed at a customer Stripe no longer has, repaired or to be. */
  readonly staleLinks: readonly string[];
  /** Things left untouched because they could not be proven to be this tooling's. */
  readonly refusals: readonly string[];
  /** Fully owned fixtures outside the scope, left alone. */
  readonly outOfScope: number;
};

/**
 * Removes billing persona fixtures from Stripe and their billing state from FactorSage.
 *
 * Deletes Test Clocks — nothing else, and only ones `classifyBillingPersonaFixture` calls `OWNED`.
 * The shared catalog cannot be affected: no product or price operation exists on the fixture
 * gateway. Each account is detached and reconciled to `FREE` **before** its Stripe customer goes,
 * so none is left pointing at a customer that has been deleted.
 *
 * The accounts themselves are kept, as `pnpm qa:reset` keeps the entitlement personas': an account
 * with no billing state is simply a `FREE` user, and keeping it keeps a signed-in browser signed in.
 */
export async function cleanupBillingPersonaFixtures(
  tooling: BillingPersonaTooling,
  options: {
    readonly scope: BillingPersonaCleanupScope;
    readonly dryRun: boolean;
    /** Whose accounts make up the `DATABASE` scope. The registry's, unless a suite says otherwise. */
    readonly personas?: readonly BillingPersona[];
  },
): Promise<BillingPersonaCleanupResult> {
  const personas = options.personas ?? BILLING_PERSONA_LIST;
  const accounts = await tooling.prisma.user.findMany({
    where: { email: { in: personas.map((persona) => persona.email) } },
    select: { id: true, email: true, stripeCustomerId: true },
  });
  const observed = await observeBillingPersonaFixtures(tooling.fixtures);
  const plan = planFixtureCleanup(
    observed,
    options.scope === "ALL_TAGGED"
      ? { kind: "ALL_TAGGED" }
      : {
          kind: "OWNERS",
          ownerUserIds: new Set(accounts.map((account) => account.id)),
        },
  );

  const refusals = plan.refusals.map(describeRefusal);
  // Customers on any fixture-looking clock: an owned one is handled by deleting its fixture, and
  // an ambiguous one has already been reported as a refusal above.
  const fixtureCustomerIds = new Set(
    observed.flatMap((fixture) =>
      fixture.kind === "OWNED"
        ? fixture.customer
          ? [fixture.customer.id]
          : []
        : fixture.customerIds,
    ),
  );

  // Accounts pointing at a customer no fixture holds: either Stripe no longer has it — the link is
  // stale and is cleared — or it exists and is not ours, which is not this command's to touch.
  const staleAccounts: { id: string; email: string }[] = [];
  for (const account of accounts) {
    const linked = account.stripeCustomerId;
    if (linked === null || fixtureCustomerIds.has(linked)) {
      continue;
    }
    if ((await tooling.fixtures.retrieveCustomer(linked)) === null) {
      staleAccounts.push(account);
    } else {
      refusals.push(
        `${account.email} is linked to Stripe customer ${linked}, which is not one of this ` +
          "tooling's fixtures; it was left alone",
      );
    }
  }

  const result = (
    done: Pick<BillingPersonaCleanupResult, "fixtures" | "staleLinks">,
  ): BillingPersonaCleanupResult => ({
    dryRun: options.dryRun,
    ...done,
    refusals,
    outOfScope: plan.outOfScope.length,
  });
  const describe = (fixture: OwnedBillingPersonaFixture) => ({
    clockId: fixture.clock.id,
    persona: fixture.identity.persona,
    ownerUserId: fixture.identity.ownerUserId,
    customerId: fixture.customer?.id ?? null,
  });

  if (options.dryRun) {
    return result({
      fixtures: plan.deletions.map(describe),
      staleLinks: staleAccounts.map((account) => account.email),
    });
  }

  const deleted: ReturnType<typeof describe>[] = [];
  for (const fixture of plan.deletions) {
    try {
      await deleteOwnedFixture(tooling, fixture);
      deleted.push(describe(fixture));
    } catch (error: unknown) {
      if (!(error instanceof BillingPersonaRefusedError)) {
        throw error;
      }
      // It changed between the listing and the delete. Leave it, say so, and carry on with the
      // rest: one fixture a person has to look at must not strand the others.
      refusals.push(error.message);
    }
  }
  for (const account of staleAccounts) {
    await detachUser(tooling, account.id);
  }

  return result({
    fixtures: deleted,
    staleLinks: staleAccounts.map((account) => account.email),
  });
}
