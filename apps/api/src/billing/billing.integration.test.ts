import { randomUUID } from "node:crypto";
import type { StripeBillingConfig } from "@intrinsic/config";
import {
  BILLING_CATALOG,
  type BillingPriceKey,
  type BillingStatusResponse,
  type UserPlan,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { PrismaService } from "../database/prisma.service";
import { BillingReconciliationService } from "./billing-reconciliation.service";
import { BillingModule } from "./billing.module";
import {
  BILLING_CATALOG_TOKEN,
  STRIPE_BILLING_CONFIG,
  STRIPE_GATEWAY,
} from "./billing.tokens";
import { BillingCatalog } from "./billing-catalog";
import { FakeStripeGateway } from "./stripe-gateway.test-helper";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * HTTP -> Nest -> BillingService/BillingReconciliationService -> real PostgreSQL, with Stripe faked
 * at the gateway boundary.
 *
 * Everything except Stripe is real: the routes, the guards, the exception filters, the advisory
 * lock, the transaction, `changeUserPlan`, and the `User.plan` column every entitlement check reads.
 * That is what makes these lifecycle assertions meaningful rather than a restatement of the fake —
 * the fake models Stripe's *observable* behaviour, and the rules being proven all live on this side
 * of the boundary.
 *
 * The suite covers the twenty acceptance cases in `docs/decisions/stripe-billing-v1.md` section 26,
 * plus the webhook robustness list in the implementation brief.
 */

const WEBHOOK_SECRET = "whsec_billing_integration_test_secret";

const PRICE_IDS: Record<BillingPriceKey, string> = {
  STARTER_MONTHLY: "price_test_starter_monthly",
  STARTER_YEARLY: "price_test_starter_yearly",
  PRO_MONTHLY: "price_test_pro_monthly",
  PRO_YEARLY: "price_test_pro_yearly",
};

const BILLING_CONFIG: StripeBillingConfig = {
  secretKey: "sk_test_integration",
  webhookSecret: WEBHOOK_SECRET,
  priceIds: PRICE_IDS,
  testMode: true,
  checkoutSuccessUrl: "http://localhost:3000/billing?checkout=success",
  checkoutCancelUrl: "http://localhost:3000/billing?checkout=cancelled",
  portalReturnUrl: "http://localhost:3000/billing",
  timeoutMs: 5_000,
  maxNetworkRetries: 0,
};

describe("billing", () => {
  const password = "Local-test-password-42";

  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: FakeStripeGateway;
  let reconciliation: BillingReconciliationService;

  let userId = "";
  let userEmail = "";
  let agent: ReturnType<typeof request.agent>;
  /** Stripe event ids this scenario delivered, so `afterEach` can remove all of them. */
  const deliveredEventIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // `EntitlementsModule` is here only so the suite can read `/entitlements` and prove billing
      // leaves it alone. `BillingModule` itself deliberately does not depend on it.
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        EntitlementsModule,
        BillingModule,
      ],
    })
      .overrideProvider(STRIPE_BILLING_CONFIG)
      .useValue(BILLING_CONFIG)
      .overrideProvider(BILLING_CATALOG_TOKEN)
      .useValue(new BillingCatalog(BILLING_CONFIG))
      .overrideProvider(STRIPE_GATEWAY)
      .useFactory({
        factory: () => new FakeStripeGateway({ webhookSecret: WEBHOOK_SECRET }),
      })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    prisma = app.get(PrismaService);
    stripe = app.get(STRIPE_GATEWAY);
    reconciliation = app.get(BillingReconciliationService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    // A fresh user and a fresh Stripe per scenario: these tests move one account through a
    // lifecycle, so sharing state between them would make every failure ambiguous.
    userEmail = `billing-${randomUUID()}@example.test`;
    const passwordService = app.get(PasswordService);
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        passwordHash: await passwordService.hash(password),
        emailVerifiedAt: new Date(),
      },
    });
    userId = user.id;

    stripe.customers.clear();
    stripe.subscriptions.clear();
    stripe.checkoutSessions.length = 0;
    stripe.portalSessions.length = 0;
    stripe.idempotencyKeys.length = 0;
    stripe.callCounts.clear();
    stripe.failNextImmediateChange = false;

    agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);
  });

  afterEach(async () => {
    // Every event this scenario delivered, including the ones deliberately ignored.
    //
    // An ignored event is recorded with `userId: null` on purpose — there was no local user to
    // attribute it to — so deleting by `userId` alone would leave those rows behind to accumulate in
    // the shared test database run after run. Tracking the ids is what keeps a suite that asserts on
    // ignored events from also littering.
    if (deliveredEventIds.length > 0) {
      await prisma.stripeWebhookEvent.deleteMany({
        where: { stripeEventId: { in: deliveredEventIds } },
      });
      deliveredEventIds.length = 0;
    }
    await prisma.stripeWebhookEvent.deleteMany({ where: { userId } });
    await prisma.billingSubscription.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function planOf(): Promise<UserPlan> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { plan: true },
    });
    return user.plan;
  }

  async function status(): Promise<BillingStatusResponse> {
    const response = await agent.get("/billing/status").expect(200);
    return response.body as BillingStatusResponse;
  }

  /** A customer and a live subscription, as a completed Checkout would have left them. */
  async function givenSubscribed(
    priceKey: BillingPriceKey,
    options: { status?: string; currentPeriodEnd?: Date } = {},
  ): Promise<{ customerId: string; subscriptionId: string }> {
    const customerId = stripe.seedCustomer(userId);
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
    const subscription = stripe.seedSubscription({
      customerId,
      priceId: PRICE_IDS[priceKey],
      ...(options.status ? { status: options.status } : {}),
      ...(options.currentPeriodEnd
        ? { currentPeriodEnd: options.currentPeriodEnd }
        : {}),
    });
    await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
    return { customerId, subscriptionId: subscription.id };
  }

  /**
   * Delivers one signed webhook, exactly as Stripe would.
   *
   * Returns supertest's chainable test rather than a promise, so `.expect(200)` asserts the status
   * the way every other suite in this app does.
   */
  function deliverWebhook(input: {
    id: string;
    type: string;
    object: Record<string, unknown>;
    created?: Date;
    livemode?: boolean;
  }) {
    const { body, signature } = stripe.signedWebhook(input);
    deliveredEventIds.push(input.id);
    return request(app.getHttpServer())
      .post("/webhooks/stripe")
      .set("stripe-signature", signature)
      .set("content-type", "application/json")
      .send(body);
  }

  function subscriptionEvent(
    subscriptionId: string,
    customerId: string,
    type = "customer.subscription.updated",
    eventId = `evt_${randomUUID()}`,
  ) {
    return {
      id: eventId,
      type,
      object: { id: subscriptionId, customer: customerId, object: "subscription" },
    };
  }

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  describe("checkout", () => {
    it("refuses a guest", async () => {
      await request(app.getHttpServer())
        .post("/billing/checkout")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(401);
      await request(app.getHttpServer()).get("/billing/status").expect(401);
      await request(app.getHttpServer()).post("/billing/portal").expect(401);
    });

    it("creates a session for a catalog key and resolves the configured price server-side", async () => {
      const response = await agent
        .post("/billing/checkout")
        .send({ priceKey: "PRO_YEARLY" })
        .expect(201);

      expect(response.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      const session = stripe.checkoutSessions.at(-1);
      expect(session?.priceId).toBe(PRICE_IDS.PRO_YEARLY);
      expect(session?.userId).toBe(userId);
      // Server configuration, never a client-supplied redirect.
      expect(session?.successUrl).toBe(BILLING_CONFIG.checkoutSuccessUrl);
      expect(session?.cancelUrl).toBe(BILLING_CONFIG.checkoutCancelUrl);
    });

    it("grants nothing merely by creating a session", async () => {
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      expect(await planOf()).toBe("FREE");
    });

    it("rejects an arbitrary Stripe price id and every other server-owned field", async () => {
      for (const body of [
        { priceId: "price_live_something" },
        { stripePriceId: PRICE_IDS.PRO_MONTHLY },
        { priceKey: "PRO_MONTHLY", priceId: "price_evil" },
        { priceKey: "PRO_MONTHLY", customerId: "cus_someone_else" },
        { priceKey: "PRO_MONTHLY", plan: "PRO" },
        { priceKey: "PRO_MONTHLY", role: "ADMIN" },
        { priceKey: "PRO_MONTHLY", successUrl: "https://evil.test/grant" },
        { priceKey: "price_1234" },
        { priceKey: "PRO_PLUS_MONTHLY" },
        { priceKey: "FREE" },
        {},
      ]) {
        await agent.post("/billing/checkout").send(body).expect(400);
      }
      expect(stripe.checkoutSessions).toHaveLength(0);
      expect(await planOf()).toBe("FREE");
    });

    it("creates one canonical customer and reuses it", async () => {
      await agent.post("/billing/checkout").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      const first = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });
      expect(first.stripeCustomerId).not.toBeNull();

      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      const second = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });
      expect(second.stripeCustomerId).toBe(first.stripeCustomerId);
      expect(stripe.callCounts.get("createCustomer")).toBe(1);
    });

    it("does not create two customers under concurrent first checkouts", async () => {
      // The race the advisory lock exists for: both requests find no customer, both create one, and
      // one id is silently lost — leaving an orphaned Stripe customer that can collect a
      // subscription nobody is looking at.
      const results = await Promise.allSettled([
        agent.post("/billing/checkout").send({ priceKey: "STARTER_MONTHLY" }),
        agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }),
      ]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);

      const customers = [...stripe.customers.values()].filter(
        (customer) => customer.userId === userId,
      );
      expect(customers).toHaveLength(1);
      expect(await planOf()).toBe("FREE");
    });

    it("refuses a second subscription when one already holds the paid slot", async () => {
      await givenSubscribed("STARTER_MONTHLY");
      const response = await agent
        .post("/billing/checkout")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_ALREADY_SUBSCRIBED");
    });

    it("refuses a second subscription while the first is still incomplete", async () => {
      // An unpaid Checkout grants nothing but still holds the slot: otherwise a user who retried a
      // declined payment could end up paying for two subscriptions when both eventually settle.
      await givenSubscribed("PRO_MONTHLY", { status: "incomplete" });
      expect(await planOf()).toBe("FREE");
      await agent.post("/billing/checkout").send({ priceKey: "STARTER_MONTHLY" }).expect(409);
    });

    it("allows checkout again once the previous subscription is terminal", async () => {
      const { subscriptionId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.endSubscription(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("FREE");
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
    });

    it("derives the checkout idempotency key from the user, price and request", async () => {
      await agent
        .post("/billing/checkout")
        .set("x-request-id", "req-fixed-1")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);
      const key = stripe.idempotencyKeys.find(
        (entry) => entry.operation === "createCheckoutSession",
      )?.key;
      expect(key).toBe(`factorsage:checkout:${userId}:PRO_MONTHLY:req-fixed-1`);

      const customerKey = stripe.idempotencyKeys.find(
        (entry) => entry.operation === "createCustomer",
      )?.key;
      // Stable forever, so no retry can ever produce a second canonical customer.
      expect(customerKey).toBe(`factorsage:customer:${userId}`);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle: new subscriptions
  // -------------------------------------------------------------------------

  describe("new subscriptions", () => {
    for (const priceKey of [
      "STARTER_MONTHLY",
      "STARTER_YEARLY",
      "PRO_MONTHLY",
      "PRO_YEARLY",
    ] as const) {
      it(`FREE -> ${priceKey} once Stripe reports it active`, async () => {
        const { subscriptionId, customerId } = await givenSubscribed(priceKey);
        await deliverWebhook(
          subscriptionEvent(subscriptionId, customerId, "customer.subscription.created"),
        ).expect(200);

        const expected = BILLING_CATALOG[priceKey];
        expect(await planOf()).toBe(expected.plan);

        const mirror = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(mirror.stripeSubscriptionId).toBe(subscriptionId);
        expect(mirror.stripePriceId).toBe(PRICE_IDS[priceKey]);
        expect(mirror.plan).toBe(expected.plan);
        expect(mirror.billingInterval).toBe(expected.interval);
        expect(mirror.status).toBe("ACTIVE");
        expect(mirror.planReason).toBe("SUBSCRIPTION_ACTIVE");
      });
    }

    it("stays FREE while the first payment is incomplete, then grants on success", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY", {
        status: "incomplete",
      });
      expect(await planOf()).toBe("FREE");

      stripe.setStatus(subscriptionId, "active");
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "invoice.paid"),
      ).expect(200);
      expect(await planOf()).toBe("PRO");
    });

    it("stays FREE when the first payment never completes", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_YEARLY", {
        status: "incomplete",
      });
      stripe.setStatus(subscriptionId, "incomplete_expired");
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId),
      ).expect(200);
      expect(await planOf()).toBe("FREE");
    });

    it("fails closed on a price outside the configured catalog", async () => {
      const customerId = stripe.seedCustomer(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      // An archived legacy price, or another environment's. It must never map to a plan.
      stripe.seedSubscription({ customerId, priceId: "price_legacy_pro_39" });

      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(result.plan).toBe("FREE");
      expect(result.planReason).toBe("PRICE_NOT_IN_CATALOG");
      expect(result.anomalous).toBe(true);
      expect(await planOf()).toBe("FREE");
    });
  });

  // -------------------------------------------------------------------------
  // Upgrades
  // -------------------------------------------------------------------------

  describe("upgrades", () => {
    it("Starter monthly -> Pro monthly is immediate once Stripe bills it", async () => {
      await givenSubscribed("STARTER_MONTHLY");
      expect(await planOf()).toBe("STARTER");

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);

      expect(response.body.effect).toBe("IMMEDIATE");
      expect(response.body.kind).toBe("TIER_UPGRADE");
      expect(response.body.plan).toBe("PRO");
      expect(await planOf()).toBe("PRO");
    });

    it("does not grant Pro when the upgrade payment fails", async () => {
      const { subscriptionId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.failNextImmediateChange = true;

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);

      // Stripe accepted the request and is holding it as a pending update; the subscription is still
      // billed at the Starter price, so the entitlement must not move.
      expect(response.body.effect).toBe("IMMEDIATE");
      expect(response.body.plan).toBe("STARTER");
      expect(await planOf()).toBe("STARTER");

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.stripePriceId).toBe(PRICE_IDS.STARTER_MONTHLY);
      expect(mirror.plan).toBe("STARTER");

      // ...and only once the held update is paid does Pro arrive.
      stripe.applyPendingUpdate(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("PRO");
    });

    it("treats Starter yearly -> Pro monthly as an immediate upgrade, not a cadence change", async () => {
      await givenSubscribed("STARTER_YEARLY");
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);
      expect(response.body.kind).toBe("TIER_UPGRADE");
      expect(response.body.effect).toBe("IMMEDIATE");
      expect(await planOf()).toBe("PRO");
    });

    it("keys the change idempotently on the transition itself", async () => {
      await givenSubscribed("STARTER_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      const key = stripe.idempotencyKeys.find(
        (entry) => entry.operation === "updateSubscriptionPriceImmediately",
      )?.key;
      expect(key).toContain(PRICE_IDS.STARTER_MONTHLY);
      expect(key).toContain(PRICE_IDS.PRO_MONTHLY);
    });
  });

  // -------------------------------------------------------------------------
  // Downgrades and cadence changes
  // -------------------------------------------------------------------------

  describe("downgrades and cadence changes", () => {
    it("Pro -> Starter is scheduled, and Pro is kept until it is effective", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_MONTHLY" })
        .expect(201);

      expect(response.body.effect).toBe("SCHEDULED");
      expect(response.body.kind).toBe("TIER_DOWNGRADE");
      expect(response.body.effectiveAt).toBeTruthy();
      expect(response.body.plan).toBe("PRO");
      expect(await planOf()).toBe("PRO");

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.plan).toBe("PRO");
      expect(mirror.pendingPlan).toBe("STARTER");
      expect(mirror.pendingInterval).toBe("MONTH");
      expect(mirror.pendingPriceId).toBe(PRICE_IDS.STARTER_MONTHLY);
      expect(mirror.pendingEffectiveAt).not.toBeNull();

      // Stripe's phase transition arrives.
      stripe.applyScheduledPhase(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("STARTER");

      const after = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(after.plan).toBe("STARTER");
      expect(after.pendingPlan).toBeNull();
    });

    it("applies a scheduled downgrade even if the new renewal enters recovery", async () => {
      // The higher paid period genuinely ended; a late Starter payment must not extend Pro.
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      stripe.applyScheduledPhase(subscriptionId);
      stripe.setStatus(subscriptionId, "past_due");

      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("STARTER");
    });

    it("Starter monthly -> Starter yearly is an immediate cadence change at the same tier", async () => {
      await givenSubscribed("STARTER_MONTHLY");
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_YEARLY" })
        .expect(201);

      expect(response.body.kind).toBe("CADENCE_LENGTHENED");
      expect(response.body.effect).toBe("IMMEDIATE");
      expect(await planOf()).toBe("STARTER");

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.billingInterval).toBe("YEAR");
      expect(mirror.pendingPlan).toBeNull();
    });

    it("Pro yearly -> Pro monthly is scheduled at the same tier", async () => {
      await givenSubscribed("PRO_YEARLY");
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);

      expect(response.body.kind).toBe("CADENCE_SHORTENED");
      expect(response.body.effect).toBe("SCHEDULED");
      expect(await planOf()).toBe("PRO");

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.billingInterval).toBe("YEAR");
      expect(mirror.pendingInterval).toBe("MONTH");
      expect(mirror.pendingPlan).toBe("PRO");
    });

    it("releases the schedule once the change applies, so cancellation still works", async () => {
      // The regression this exists for: Stripe refuses to change cancellation behaviour while a
      // schedule manages the subscription, and a schedule whose final phase is open-ended never ends
      // on its own. Left attached, every user who ever changed plan would permanently lose the
      // ability to cancel. Sandbox testing is where that surfaced.
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);

      const scheduled = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(scheduled.stripeScheduleId).not.toBeNull();
      expect(scheduled.pendingPlan).toBe("STARTER");

      // The boundary arrives and the phase becomes current.
      stripe.applyScheduledPhase(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      const applied = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(applied.plan).toBe("STARTER");
      expect(applied.pendingPlan).toBeNull();
      // Detached locally and at Stripe, so the subscription is independently manageable again.
      expect(applied.stripeScheduleId).toBeNull();
      expect(stripe.subscriptions.get(subscriptionId)?.scheduleId).toBeNull();

      // And the thing the release exists for: cancelling now succeeds instead of being refused.
      expect(() => stripe.scheduleCancellation(subscriptionId)).not.toThrow();
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      const cancelling = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(cancelling.cancelAtPeriodEnd).toBe(true);
      expect(await planOf()).toBe("STARTER");
    });

    it("keeps the schedule while its change is still pending", async () => {
      // The other half: a schedule with work left must not be released, or the scheduled change
      // would simply never happen.
      await givenSubscribed("PRO_YEARLY");
      await agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.stripeScheduleId).not.toBeNull();
      expect(mirror.pendingInterval).toBe("MONTH");
    });

    it("refuses a change to the price already held", async () => {
      await givenSubscribed("PRO_MONTHLY");
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_CHANGE_NOT_ALLOWED");
    });

    it("refuses a change with no subscription at all", async () => {
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_NO_SUBSCRIPTION");
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe("cancellation", () => {
    it("keeps the plan while cancellation is only scheduled", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      stripe.scheduleCancellation(subscriptionId);
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);

      expect(await planOf()).toBe("PRO");
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.cancelAtPeriodEnd).toBe(true);
      expect(mirror.cancelAt).not.toBeNull();
      expect(mirror.plan).toBe("PRO");
    });

    it("becomes FREE when the subscription actually ends", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      stripe.scheduleCancellation(subscriptionId);
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);
      expect(await planOf()).toBe("PRO");

      stripe.endSubscription(subscriptionId);
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "customer.subscription.deleted"),
      ).expect(200);
      expect(await planOf()).toBe("FREE");
    });

    it("preserves the plan when a cancellation is reversed before period end", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_YEARLY");
      stripe.scheduleCancellation(subscriptionId);
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);
      expect(await planOf()).toBe("STARTER");

      stripe.reverseCancellation(subscriptionId);
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);
      expect(await planOf()).toBe("STARTER");

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.cancelAtPeriodEnd).toBe(false);
    });

    it("refuses a plan change while cancellation is pending", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      stripe.scheduleCancellation(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_CHANGE_NOT_ALLOWED");
    });
  });

  // -------------------------------------------------------------------------
  // Payment failure and recovery
  // -------------------------------------------------------------------------

  describe("payment failure", () => {
    it("keeps the current plan through past_due recovery", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      stripe.setStatus(subscriptionId, "past_due");
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "invoice.payment_failed"),
      ).expect(200);

      expect(await planOf()).toBe("PRO");
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.status).toBe("PAST_DUE");
      expect(mirror.planReason).toBe("SUBSCRIPTION_IN_RECOVERY");
    });

    it("restores normal state when recovery succeeds", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.setStatus(subscriptionId, "past_due");
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "invoice.payment_failed"),
      ).expect(200);
      stripe.setStatus(subscriptionId, "active");
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "invoice.paid"),
      ).expect(200);

      expect(await planOf()).toBe("STARTER");
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.status).toBe("ACTIVE");
    });

    it("becomes FREE at the terminal unpaid state", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_YEARLY");
      stripe.setStatus(subscriptionId, "unpaid");
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);
      expect(await planOf()).toBe("FREE");
    });

    it("does not grant a plan for a status V1 does not sell", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      for (const unsupported of ["trialing", "paused", "something_new"]) {
        stripe.setStatus(subscriptionId, unsupported);
        await deliverWebhook(
          subscriptionEvent(subscriptionId, customerId, "customer.subscription.updated"),
        ).expect(200);
        expect(await planOf()).toBe("FREE");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  describe("webhooks", () => {
    it("rejects an unsigned or wrongly signed body and changes nothing", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.setStatus(subscriptionId, "canceled");

      const payload = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.updated",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: { id: subscriptionId, customer: customerId } },
      });

      await request(app.getHttpServer())
        .post("/webhooks/stripe")
        .set("content-type", "application/json")
        .send(payload)
        .expect(400);

      await request(app.getHttpServer())
        .post("/webhooks/stripe")
        .set("stripe-signature", "t=1,v1=deadbeef")
        .set("content-type", "application/json")
        .send(payload)
        .expect(400);

      // The plan is untouched, and nothing was recorded.
      expect(await planOf()).toBe("STARTER");
      expect(await prisma.stripeWebhookEvent.count({ where: { userId } })).toBe(0);
    });

    it("rejects a body that was tampered with after signing", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      const { body, signature } = stripe.signedWebhook(
        subscriptionEvent(subscriptionId, customerId),
      );
      await request(app.getHttpServer())
        .post("/webhooks/stripe")
        .set("stripe-signature", signature)
        .set("content-type", "application/json")
        .send(`${body.slice(0, -1)} }`)
        .expect(400);
    });

    it("processes a duplicate delivery exactly once", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.setStatus(subscriptionId, "canceled");
      const event = subscriptionEvent(subscriptionId, customerId);

      const first = await deliverWebhook(event).expect(200);
      expect(first.body.outcome).toBe("APPLIED");
      expect(await planOf()).toBe("FREE");

      const second = await deliverWebhook(event).expect(200);
      expect(second.body.outcome).toBe("DUPLICATE_EVENT");

      expect(
        await prisma.stripeWebhookEvent.count({
          where: { stripeEventId: event.id },
        }),
      ).toBe(1);
    });

    it("serializes two concurrent copies of one event without duplicating effects", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.setStatus(subscriptionId, "canceled");
      const event = subscriptionEvent(subscriptionId, customerId);

      const responses = await Promise.all([
        deliverWebhook(event),
        deliverWebhook(event),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const outcomes = responses.map((response) => response.body.outcome).sort();
      expect(outcomes).toEqual(["APPLIED", "DUPLICATE_EVENT"]);
      expect(
        await prisma.stripeWebhookEvent.count({
          where: { stripeEventId: event.id },
        }),
      ).toBe(1);
      expect(await planOf()).toBe("FREE");
    });

    it("converges when a stale event is delivered after a newer state is already effective", async () => {
      // The regression the fetch-inside-the-lock design exists to prevent: an old event must not
      // resurrect the plan it was generated under.
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      const staleEvent = subscriptionEvent(
        subscriptionId,
        customerId,
        "customer.subscription.updated",
        `evt_stale_${randomUUID()}`,
      );

      // Newer state becomes effective first.
      stripe.endSubscription(subscriptionId);
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "customer.subscription.deleted"),
      ).expect(200);
      expect(await planOf()).toBe("FREE");

      // The delayed older event arrives now, carrying a payload from when the user was STARTER.
      await deliverWebhook({
        ...staleEvent,
        created: new Date(Date.now() - 600_000),
      }).expect(200);

      expect(await planOf()).toBe("FREE");
    });

    it("converges to the same state whatever order events arrive in", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.failNextImmediateChange = false;
      stripe.subscriptions.get(subscriptionId)!.currentPriceId = PRICE_IDS.PRO_YEARLY;

      // invoice.paid before customer.subscription.updated, i.e. the reverse of creation order.
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "invoice.paid"),
      ).expect(200);
      expect(await planOf()).toBe("PRO");

      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "customer.subscription.updated"),
      ).expect(200);
      expect(await planOf()).toBe("PRO");
    });

    it("acknowledges an event for a customer it has never seen, and changes nothing", async () => {
      const response = await deliverWebhook({
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.updated",
        object: { id: "sub_unknown", customer: "cus_never_seen" },
      }).expect(200);

      expect(response.body.outcome).toBe("IGNORED_UNKNOWN_CUSTOMER");
      expect(await planOf()).toBe("FREE");
    });

    it("acknowledges an event type it does not handle without touching state", async () => {
      const { customerId } = await givenSubscribed("PRO_MONTHLY");
      const response = await deliverWebhook({
        id: `evt_${randomUUID()}`,
        type: "charge.refunded",
        object: { id: "ch_1", customer: customerId },
      }).expect(200);

      expect(response.body.outcome).toBe("IGNORED_UNHANDLED_TYPE");
      expect(await planOf()).toBe("PRO");
    });

    it("refuses an event from the other Stripe environment", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      const response = await deliverWebhook({
        ...subscriptionEvent(subscriptionId, customerId),
        // A live event arriving at a sandbox deployment.
        livemode: true,
      }).expect(200);

      expect(response.body.outcome).toBe("IGNORED_ENVIRONMENT_MISMATCH");
      expect(await planOf()).toBe("STARTER");
    });

    it("leaves the event unprocessed when processing fails, so Stripe retries", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      const event = subscriptionEvent(subscriptionId, customerId);

      // A transient Stripe failure part-way through: the marker was already inserted, so this also
      // proves the rollback takes it with it rather than burning the event id.
      const original = stripe.loadCustomerBillingState.bind(stripe);
      stripe.loadCustomerBillingState = async () => {
        throw new Error("Stripe is unreachable");
      };
      await deliverWebhook(event).expect(500);
      stripe.loadCustomerBillingState = original;

      expect(
        await prisma.stripeWebhookEvent.count({
          where: { stripeEventId: event.id },
        }),
      ).toBe(0);

      // Stripe's retry then succeeds normally.
      stripe.setStatus(subscriptionId, "canceled");
      const retry = await deliverWebhook(event).expect(200);
      expect(retry.body.outcome).toBe("APPLIED");
      expect(await planOf()).toBe("FREE");
    });

    it("writes the plan and the mirror atomically", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      expect(await planOf()).toBe("PRO");

      stripe.subscriptions.get(subscriptionId)!.currentPriceId =
        PRICE_IDS.STARTER_YEARLY;
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);

      const [user, mirror] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } }),
        prisma.billingSubscription.findUniqueOrThrow({ where: { userId } }),
      ]);
      // The row justifying the plan and the plan itself always agree: they commit together.
      expect(user.plan).toBe("STARTER");
      expect(mirror.plan).toBe("STARTER");
      expect(mirror.billingInterval).toBe("YEAR");
    });
  });

  // -------------------------------------------------------------------------
  // One-subscription invariant
  // -------------------------------------------------------------------------

  describe("one-subscription invariant", () => {
    it("never grants more than one subscription's plan when Stripe holds two live ones", async () => {
      const customerId = stripe.seedCustomer(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });

      const older = stripe.seedSubscription({
        customerId,
        priceId: PRICE_IDS.STARTER_MONTHLY,
        created: new Date(Date.now() - 86_400_000),
      });
      stripe.seedSubscription({
        customerId,
        priceId: PRICE_IDS.PRO_YEARLY,
        created: new Date(),
      });

      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      // Deterministically the oldest, never the most generous, and flagged for an operator.
      expect(result.plan).toBe("STARTER");
      expect(result.anomalous).toBe(true);
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.stripeSubscriptionId).toBe(older.id);
    });

    it("keeps mirroring the subscription it already mirrors when a second appears", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.seedSubscription({
        customerId,
        priceId: PRICE_IDS.PRO_YEARLY,
        created: new Date(Date.now() - 86_400_000),
      });

      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      // Stability: the canonical subscription does not change identity under a user.
      expect(mirror.stripeSubscriptionId).toBe(subscriptionId);
      expect(await planOf()).toBe("STARTER");
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation and repair
  // -------------------------------------------------------------------------

  describe("reconciliation", () => {
    it("repairs a user whose webhook was never delivered", async () => {
      const customerId = stripe.seedCustomer(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
      stripe.seedSubscription({ customerId, priceId: PRICE_IDS.PRO_YEARLY });

      // No webhook at all — the outage case.
      expect(await planOf()).toBe("FREE");

      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(result.plan).toBe("PRO");
      expect(result.planChanged).toBe(true);
      expect(await planOf()).toBe("PRO");
    });

    it("is idempotent when run repeatedly", async () => {
      await givenSubscribed("STARTER_YEARLY");
      const first = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      const second = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      const third = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      expect([first.plan, second.plan, third.plan]).toEqual([
        "STARTER",
        "STARTER",
        "STARTER",
      ]);
      expect(second.planChanged).toBe(false);
      expect(third.planChanged).toBe(false);
      expect(await prisma.billingSubscription.count({ where: { userId } })).toBe(1);
    });

    it("falls to FREE when a restored database has a mirror but Stripe has no customer", async () => {
      await givenSubscribed("PRO_MONTHLY");
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: null },
      });

      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(result.outcome).toBe("NO_CUSTOMER");
      expect(result.plan).toBe("FREE");
      expect(await prisma.billingSubscription.count({ where: { userId } })).toBe(0);
    });

    it("re-adopts a Stripe customer whose local link was lost", async () => {
      const customerId = stripe.seedCustomer(userId);
      stripe.seedSubscription({ customerId, priceId: PRICE_IDS.PRO_MONTHLY });
      // The link is missing, as after a partial restore; the checkout session still names the user.
      expect(await planOf()).toBe("FREE");

      await deliverWebhook({
        id: `evt_${randomUUID()}`,
        type: "checkout.session.completed",
        object: {
          id: "cs_recovered",
          customer: customerId,
          client_reference_id: userId,
          metadata: { factorsageUserId: userId },
        },
      }).expect(200);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { plan: true, stripeCustomerId: true },
      });
      expect(user.stripeCustomerId).toBe(customerId);
      expect(user.plan).toBe("PRO");
    });
  });

  // -------------------------------------------------------------------------
  // Portal
  // -------------------------------------------------------------------------

  describe("customer portal", () => {
    it("opens a session bound to the caller's own customer", async () => {
      const { customerId } = await givenSubscribed("PRO_MONTHLY");
      const response = await agent.post("/billing/portal").expect(201);

      expect(response.body.portalUrl).toContain(customerId);
      expect(stripe.portalSessions.at(-1)?.customerId).toBe(customerId);
      expect(stripe.portalSessions.at(-1)?.returnUrl).toBe(
        BILLING_CONFIG.portalReturnUrl,
      );
    });

    it("cannot be pointed at another user's customer", async () => {
      const { customerId: victim } = await givenSubscribed("PRO_MONTHLY");
      const attacker = stripe.seedCustomer("someone-else");

      // There is no field to send: the route takes no body at all, and the customer comes from the
      // session. Sending one changes nothing.
      const response = await agent
        .post("/billing/portal")
        .send({ customerId: attacker })
        .expect(201);
      expect(response.body.portalUrl).toContain(victim);
      expect(response.body.portalUrl).not.toContain(attacker);
    });

    it("refuses when the user has no Stripe customer", async () => {
      const response = await agent.post("/billing/portal").expect(409);
      expect(response.body.code).toBe("BILLING_NO_SUBSCRIPTION");
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("reports a FREE user with the catalog and no subscription", async () => {
      const body = await status();
      expect(body.plan).toBe("FREE");
      expect(body.billingEnabled).toBe(true);
      expect(body.subscription).toBeNull();
      expect(body.canStartCheckout).toBe(true);
      expect(body.canOpenPortal).toBe(false);
      expect(body.canChangePlan).toBe(false);
      expect(body.catalog.map((entry) => entry.key)).toEqual([
        "STARTER_MONTHLY",
        "STARTER_YEARLY",
        "PRO_MONTHLY",
        "PRO_YEARLY",
      ]);
    });

    it("reports a paid user's interval, renewal and management options", async () => {
      await givenSubscribed("PRO_YEARLY");
      const body = await status();

      expect(body.plan).toBe("PRO");
      expect(body.subscription?.plan).toBe("PRO");
      expect(body.subscription?.interval).toBe("YEAR");
      expect(body.subscription?.status).toBe("ACTIVE");
      expect(body.subscription?.currentPeriodEnd).toBeTruthy();
      expect(body.canStartCheckout).toBe(false);
      expect(body.canOpenPortal).toBe(true);
      expect(body.canChangePlan).toBe(true);
    });

    it("reports a pending scheduled change", async () => {
      await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);

      const pending = await status();
      expect(pending.plan).toBe("PRO");
      expect(pending.subscription?.pendingChange).toEqual({
        plan: "STARTER",
        interval: "MONTH",
        effectiveAt: expect.any(String),
      });
    });

    it("reports a scheduled cancellation", async () => {
      // Deliberately a separate scenario from the pending change above, not a continuation of it:
      // Stripe refuses to set cancellation behaviour while a schedule manages the subscription, so
      // asserting both states on one subscription would be asserting something real Stripe cannot
      // produce. The fake models that refusal, which is how the two got separated.
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      stripe.scheduleCancellation(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      const cancelling = await status();
      expect(cancelling.plan).toBe("PRO");
      expect(cancelling.subscription?.cancelAtPeriodEnd).toBe(true);
      expect(cancelling.subscription?.cancelAt).toBeTruthy();
      expect(cancelling.subscription?.pendingChange).toBeNull();
    });

    it("exposes no Stripe identifiers to the browser", async () => {
      await givenSubscribed("PRO_MONTHLY");
      const serialized = JSON.stringify(await status());
      expect(serialized).not.toContain("cus_");
      expect(serialized).not.toContain("sub_");
      expect(serialized).not.toContain("price_");
      expect(serialized).not.toContain("sk_test");
      expect(serialized).not.toContain("whsec_");
    });

    it("refreshes from Stripe without granting anything the reconciler would not", async () => {
      const { subscriptionId } = await givenSubscribed("STARTER_MONTHLY", {
        status: "incomplete",
      });
      const before = await agent.post("/billing/refresh").expect(201);
      expect((before.body as BillingStatusResponse).plan).toBe("FREE");

      stripe.setStatus(subscriptionId, "active");
      const after = await agent.post("/billing/refresh").expect(201);
      expect((after.body as BillingStatusResponse).plan).toBe("STARTER");
    });
  });

  // -------------------------------------------------------------------------
  // The entitlement boundary
  // -------------------------------------------------------------------------

  describe("entitlement boundary", () => {
    it("never touches the role", async () => {
      await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");

      stripe.endSubscription(subscriptionId);
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "customer.subscription.deleted"),
      ).expect(200);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { plan: true, role: true },
      });
      // Cancellation takes the plan and leaves the role exactly where it was.
      expect(user.plan).toBe("FREE");
      expect(user.role).toBe("ADMIN");
    });

    it("leaves an ADMIN's entitlements independent of billing", async () => {
      await prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
      const entitlements = await agent.get("/entitlements").expect(200);
      expect(entitlements.body.entitlements.tier).toBe("ADMIN");
      expect(entitlements.body.plan).toBe("FREE");
    });

    it("makes a downgrade non-destructive", async () => {
      const { subscriptionId, customerId } = await givenSubscribed("PRO_MONTHLY");
      const list = await prisma.stockList.create({
        data: { userId, name: `billing-downgrade-${randomUUID()}` },
      });

      stripe.endSubscription(subscriptionId);
      await deliverWebhook(
        subscriptionEvent(subscriptionId, customerId, "customer.subscription.deleted"),
      ).expect(200);

      expect(await planOf()).toBe("FREE");
      // Billing changes one column. Nothing the user created is removed or rewritten.
      const survived = await prisma.stockList.findUnique({ where: { id: list.id } });
      expect(survived).not.toBeNull();

      await prisma.stockList.delete({ where: { id: list.id } });
    });
  });
});
