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
  PRO_PLUS_MONTHLY: "price_test_pro_plus_monthly",
  PRO_PLUS_YEARLY: "price_test_pro_plus_yearly",
};

const ALL_PRICE_KEYS = Object.keys(PRICE_IDS) as BillingPriceKey[];

/**
 * Retired V1 prices existing subscribers may still be billed on (`STRIPE_LEGACY_PRICES`): the $299
 * Pro year, the $99 Starter year and the $9 Starter month. Distinct from the V2 years above, which
 * are sold; these never are.
 */
const LEGACY_PRO_YEARLY = "price_test_legacy_pro_yearly";
const LEGACY_STARTER_YEARLY = "price_test_legacy_starter_yearly";
const LEGACY_STARTER_MONTHLY = "price_test_legacy_starter_monthly";

const BILLING_CONFIG: StripeBillingConfig = {
  secretKey: "sk_test_integration",
  webhookSecret: WEBHOOK_SECRET,
  priceIds: PRICE_IDS,
  legacyPrices: [
    { priceId: LEGACY_PRO_YEARLY, plan: "PRO", interval: "YEAR" },
    { priceId: LEGACY_STARTER_YEARLY, plan: "STARTER", interval: "YEAR" },
    { priceId: LEGACY_STARTER_MONTHLY, plan: "STARTER", interval: "MONTH" },
  ],
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
        factory: () =>
          new FakeStripeGateway({
            webhookSecret: WEBHOOK_SECRET,
            intervalOf: (priceId) => {
              const key = (Object.keys(PRICE_IDS) as BillingPriceKey[]).find(
                (candidate) => PRICE_IDS[candidate] === priceId,
              );
              const legacy = BILLING_CONFIG.legacyPrices?.find(
                (candidate) => candidate.priceId === priceId,
              );
              return key ? BILLING_CATALOG[key].interval : (legacy?.interval ?? null);
            },
          }),
      })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    // Bound to loopback, never left unlistened: an unlistened app makes supertest bind a
    // wildcard port per request, which on macOS can be one another process holds on
    // 127.0.0.1 (`ai/workflows/validation.md`, "bind it to loopback").
    await app.listen(0, "127.0.0.1");

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
    stripe.failNextScheduleRelease = false;
    stripe.completeDuringNextSweep = null;
    stripe.loadLatencyMs = 0;

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
        .send({ priceKey: "PRO_PLUS_MONTHLY" })
        .expect(201);

      expect(response.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      const session = stripe.checkoutSessions.at(-1);
      expect(session?.priceId).toBe(PRICE_IDS.PRO_PLUS_MONTHLY);
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
        // A retired V1 price is not a key, and neither is a cadence spelled another way.
        { priceKey: LEGACY_PRO_YEARLY },
        { priceKey: "PRO_PLUS_ANNUAL" },
        { priceKey: "pro_yearly" },
        { priceKey: "FREE" },
        { priceKey: "FREE_YEARLY" },
        {},
      ]) {
        await agent.post("/billing/checkout").send(body).expect(400);
      }
      expect(stripe.checkoutSessions).toHaveLength(0);
      expect(await planOf()).toBe("FREE");
    });

    for (const priceKey of ALL_PRICE_KEYS) {
      it(`opens Checkout for ${priceKey} on the price configured for it`, async () => {
        await agent.post("/billing/checkout").send({ priceKey }).expect(201);
        expect(stripe.checkoutSessions).toHaveLength(1);
        expect(stripe.checkoutSessions[0]?.priceId).toBe(PRICE_IDS[priceKey]);
        expect(await planOf()).toBe("FREE");
      });
    }

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

    it("keeps the customer's idempotency key stable forever and gives Checkout none to replay", async () => {
      await agent
        .post("/billing/checkout")
        .set("x-request-id", "req-fixed-1")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);
      const customerKey = stripe.idempotencyKeys.find(
        (entry) => entry.operation === "createCustomer",
      )?.key;
      // Stable forever, so no retry can ever produce a second canonical customer.
      expect(customerKey).toBe(`factorsage:customer:${userId}`);

      // A replayed Checkout key would hand back a session the sweep below had just expired (BILL-02),
      // so creation carries none; the SDK still keys the POST for its own network retries.
      expect(
        stripe.idempotencyKeys.filter(
          (entry) => entry.operation === "createCheckoutSession",
        ),
      ).toEqual([]);
      expect(stripe.callCounts.get("createCheckoutSession")).toBe(1);
    });

    it("gives a session a short life rather than Stripe's default day", async () => {
      const before = Date.now();
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      const expiresAt = stripe.checkoutSessions[0]!.expiresAt.getTime();
      // Stripe's floor is 30 minutes after creation; anything near a day is the default it replaced.
      expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 60_000);
      expect(expiresAt - before).toBeLessThanOrEqual(60 * 60_000);
    });
  });

  // -------------------------------------------------------------------------
  // One payable Checkout per customer (BILL-02)
  // -------------------------------------------------------------------------

  /**
   * Pre-release audit 2026-10-16, finding BILL-02 (`docs/audits/pre-release-audit-2026-10-16.md`):
   * two Checkout tabs opened before either was paid were both payable in the Stripe sandbox, and
   * each payment created its own live PRO subscription — two charges, renewing monthly. The guard
   * read only the mirror, which learns of a payment one webhook later.
   */
  describe("one payable Checkout per customer", () => {
    it("expires the first tab's session when a second is opened, so only one can be paid", async () => {
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);

      const [first, second] = stripe.checkoutSessions;
      expect(first?.status).toBe("expired");
      expect(second?.status).toBe("open");
      // The first tab is still on screen; paying it is refused by Stripe itself.
      expect(() => stripe.completeCheckoutSession(first!.id)).toThrow(/not payable/);

      const paid = stripe.completeCheckoutSession(second!.id);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("PRO");
      expect(
        [...stripe.subscriptions.values()].filter(
          (subscription) => subscription.status === "active",
        ),
      ).toEqual([expect.objectContaining({ id: paid.id })]);
    });

    it("leaves exactly one session payable when several requests arrive at once", async () => {
      stripe.loadLatencyMs = 25;
      const responses = await Promise.all(
        (["STARTER_MONTHLY", "PRO_MONTHLY", "PRO_PLUS_MONTHLY"] as const).map((priceKey) =>
          agent.post("/billing/checkout").send({ priceKey }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(stripe.checkoutSessions).toHaveLength(3);
      expect(
        stripe.checkoutSessions.filter((session) => session.status === "open"),
      ).toHaveLength(1);
      expect(
        [...stripe.customers.values()].filter((customer) => customer.userId === userId),
      ).toHaveLength(1);
    });

    it("refuses a session when Stripe holds a subscription the mirror has not seen, and catches the mirror up", async () => {
      // The first tab was paid a moment ago and its webhook has not arrived: the mirror is empty.
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      stripe.completeCheckoutSession(stripe.checkoutSessions[0]!.id);
      expect(
        await prisma.billingSubscription.findUnique({ where: { userId } }),
      ).toBeNull();

      const response = await agent
        .post("/billing/checkout")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_ALREADY_SUBSCRIBED");
      expect(stripe.checkoutSessions).toHaveLength(1);
      // The refusal reconciled: the page now shows the subscription instead of offering Checkout.
      expect(await planOf()).toBe("PRO");
      expect((await status()).canStartCheckout).toBe(false);
    });

    it("refuses a session when the open one is paid while it is being expired", async () => {
      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      stripe.completeDuringNextSweep = stripe.checkoutSessions[0]!.id;

      const response = await agent
        .post("/billing/checkout")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(409);
      expect(response.body.code).toBe("BILLING_ALREADY_SUBSCRIBED");
      expect(stripe.checkoutSessions).toHaveLength(1);
      expect(stripe.checkoutSessions[0]?.status).toBe("complete");
      expect(await planOf()).toBe("PRO");
    });

    it("still lets a customer whose previous subscription ended start again", async () => {
      const { subscriptionId } = await givenSubscribed("STARTER_MONTHLY");
      stripe.endSubscription(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      await agent.post("/billing/checkout").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      expect(stripe.checkoutSessions.at(-1)?.status).toBe("open");
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle: new subscriptions
  // -------------------------------------------------------------------------

  describe("new subscriptions", () => {
    for (const priceKey of ALL_PRICE_KEYS) {
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
      const { subscriptionId, customerId } = await givenSubscribed("PRO_PLUS_MONTHLY", {
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
  // Retired (legacy) prices — entitlements-v2 §2
  // -------------------------------------------------------------------------

  describe("subscribers on a retired price", () => {
    async function givenLegacy(priceId: string) {
      const customerId = stripe.seedCustomer(userId);
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
      const subscription = stripe.seedSubscription({ customerId, priceId });
      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      return { customerId, subscriptionId: subscription.id, result };
    }

    it("keep their plan (grandfathered) instead of failing closed to Free", async () => {
      const { result } = await givenLegacy(LEGACY_PRO_YEARLY);
      expect(result.plan).toBe("PRO");
      expect(result.planReason).toBe("SUBSCRIPTION_ACTIVE");
      expect(result.anomalous).toBe(false);
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({ where: { userId } });
      expect(mirror).toMatchObject({
        plan: "PRO",
        billingInterval: "YEAR",
        stripePriceId: LEGACY_PRO_YEARLY,
      });
    });

    it("move up a tier immediately, onto today's price", async () => {
      const { subscriptionId } = await givenLegacy(LEGACY_STARTER_MONTHLY);
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_PLUS_MONTHLY" })
        .expect(201);
      expect(response.body).toMatchObject({ effect: "IMMEDIATE", kind: "TIER_UPGRADE", plan: "PRO_PLUS" });
      expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(PRICE_IDS.PRO_PLUS_MONTHLY);
    });

    it("move down a tier at period end, keeping the paid period", async () => {
      await givenLegacy(LEGACY_PRO_YEARLY);
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_MONTHLY" })
        .expect(201);
      expect(response.body).toMatchObject({ effect: "SCHEDULED", kind: "TIER_DOWNGRADE" });
      expect(await planOf()).toBe("PRO");
    });

    it("are already on their plan: today's year of the same plan is not a change", async () => {
      // Nothing moves a grandfathered subscriber onto today's price of what they already have:
      // the retired $299 year stays theirs until they choose a different plan or cadence.
      const { subscriptionId } = await givenLegacy(LEGACY_PRO_YEARLY);
      const refused = await agent.post("/billing/change").send({ priceKey: "PRO_YEARLY" });
      expect(refused.status).toBe(409);
      expect((refused.body as { code: string }).code).toBe("BILLING_CHANGE_NOT_ALLOWED");
      expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(LEGACY_PRO_YEARLY);
      expect(stripe.callCounts.get("updateSubscriptionPriceImmediately") ?? 0).toBe(0);
      expect(stripe.callCounts.get("scheduleSubscriptionPriceChange") ?? 0).toBe(0);
    });

    it("keep a retired year until its end when they choose today's month of the plan", async () => {
      const { subscriptionId } = await givenLegacy(LEGACY_PRO_YEARLY);
      const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_MONTHLY" })
        .expect(201);
      expect(response.body).toMatchObject({
        effect: "SCHEDULED",
        kind: "CADENCE_SHORTENED",
        plan: "PRO",
        effectiveAt: periodEnd.toISOString(),
      });
      // Still billed on the retired year, which the subscriber has paid for.
      expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(LEGACY_PRO_YEARLY);
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({ where: { userId } });
      expect(mirror).toMatchObject({
        stripePriceId: LEGACY_PRO_YEARLY,
        pendingPriceId: PRICE_IDS.PRO_MONTHLY,
        pendingInterval: "MONTH",
      });
    });

    it("move from a retired month to today's year of the plan immediately", async () => {
      const { subscriptionId } = await givenLegacy(LEGACY_STARTER_MONTHLY);
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_YEARLY" })
        .expect(201);
      expect(response.body).toMatchObject({
        effect: "IMMEDIATE",
        kind: "CADENCE_LENGTHENED",
        plan: "STARTER",
      });
      expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(
        PRICE_IDS.STARTER_YEARLY,
      );
      expect((await status()).subscription).toMatchObject({
        interval: "YEAR",
        legacyPrice: false,
      });
    });

    it("move up a tier from a retired year immediately, onto today's price", async () => {
      const { subscriptionId } = await givenLegacy(LEGACY_STARTER_YEARLY);
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_YEARLY" })
        .expect(201);
      expect(response.body).toMatchObject({ effect: "IMMEDIATE", kind: "TIER_UPGRADE", plan: "PRO" });
      expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(PRICE_IDS.PRO_YEARLY);
    });

    it("are reported as on a retired price, which today's subscribers are not", async () => {
      await givenLegacy(LEGACY_STARTER_YEARLY);
      expect((await status()).subscription).toMatchObject({
        plan: "STARTER",
        interval: "YEAR",
        legacyPrice: true,
      });
    });

    it("cannot be bought: no logical key names a retired price, and a year is sold at today's", async () => {
      // A retired price id is not a key, so the request is refused outright.
      const refused = await agent
        .post("/billing/checkout")
        .send({ priceKey: LEGACY_PRO_YEARLY });
      expect(refused.status).toBe(400);
      expect(stripe.checkoutSessions).toHaveLength(0);

      // A year bought today is today's year, never the retired one.
      await agent.post("/billing/checkout").send({ priceKey: "PRO_YEARLY" }).expect(201);
      expect(stripe.checkoutSessions.at(-1)?.priceId).toBe(PRICE_IDS.PRO_YEARLY);
      expect(stripe.checkoutSessions.at(-1)?.priceId).not.toBe(LEGACY_PRO_YEARLY);
    });
  });

  // -------------------------------------------------------------------------
  // Upgrades
  // -------------------------------------------------------------------------

  describe("upgrades", () => {
    // Every move to a higher tier, Starter -> Pro+ included, in any pair of cadences: one immediate
    // change, never two steps. Tier beats interval — a year of Starter to a month of Pro is an
    // upgrade, not a shortened cadence.
    for (const [from, to, fromPlan, toPlan] of [
      ["STARTER_MONTHLY", "PRO_MONTHLY", "STARTER", "PRO"],
      ["PRO_MONTHLY", "PRO_PLUS_MONTHLY", "PRO", "PRO_PLUS"],
      ["STARTER_MONTHLY", "PRO_PLUS_MONTHLY", "STARTER", "PRO_PLUS"],
      ["STARTER_YEARLY", "PRO_YEARLY", "STARTER", "PRO"],
      ["STARTER_YEARLY", "PRO_MONTHLY", "STARTER", "PRO"],
      ["STARTER_MONTHLY", "PRO_YEARLY", "STARTER", "PRO"],
      ["STARTER_YEARLY", "PRO_PLUS_YEARLY", "STARTER", "PRO_PLUS"],
      ["STARTER_MONTHLY", "PRO_PLUS_YEARLY", "STARTER", "PRO_PLUS"],
      ["PRO_YEARLY", "PRO_PLUS_YEARLY", "PRO", "PRO_PLUS"],
      ["PRO_YEARLY", "PRO_PLUS_MONTHLY", "PRO", "PRO_PLUS"],
      ["PRO_MONTHLY", "PRO_PLUS_YEARLY", "PRO", "PRO_PLUS"],
    ] as const) {
      it(`${from} -> ${to} is immediate once Stripe bills it`, async () => {
        const { subscriptionId } = await givenSubscribed(from);
        expect(await planOf()).toBe(fromPlan);

        const response = await agent
          .post("/billing/change")
          .send({ priceKey: to })
          .expect(201);

        expect(response.body.effect).toBe("IMMEDIATE");
        expect(response.body.kind).toBe("TIER_UPGRADE");
        expect(response.body.plan).toBe(toPlan);
        expect(await planOf()).toBe(toPlan);

        expect(stripe.callCounts.get("updateSubscriptionPriceImmediately")).toBe(1);
        expect(stripe.subscriptions.get(subscriptionId)).toMatchObject({
          currentPriceId: PRICE_IDS[to],
          scheduledPhase: null,
        });
        const mirror = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(mirror).toMatchObject({
          plan: toPlan,
          stripePriceId: PRICE_IDS[to],
          pendingPlan: null,
        });
      });
    }

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
  // Downgrades and scheduled changes
  // -------------------------------------------------------------------------

  describe("downgrades and scheduled changes", () => {
    // Every move to a lower tier waits for the end of the period already paid for, in any pair of
    // cadences: tier beats interval, so a month of Pro to a year of Starter is a downgrade too.
    for (const [from, to, fromPlan, toPlan] of [
      ["PRO_MONTHLY", "STARTER_MONTHLY", "PRO", "STARTER"],
      ["PRO_PLUS_MONTHLY", "PRO_MONTHLY", "PRO_PLUS", "PRO"],
      ["PRO_PLUS_MONTHLY", "STARTER_MONTHLY", "PRO_PLUS", "STARTER"],
      ["PRO_YEARLY", "STARTER_YEARLY", "PRO", "STARTER"],
      ["PRO_YEARLY", "STARTER_MONTHLY", "PRO", "STARTER"],
      ["PRO_MONTHLY", "STARTER_YEARLY", "PRO", "STARTER"],
      ["PRO_PLUS_YEARLY", "PRO_YEARLY", "PRO_PLUS", "PRO"],
      ["PRO_PLUS_YEARLY", "PRO_MONTHLY", "PRO_PLUS", "PRO"],
      ["PRO_PLUS_MONTHLY", "PRO_YEARLY", "PRO_PLUS", "PRO"],
      ["PRO_PLUS_YEARLY", "STARTER_YEARLY", "PRO_PLUS", "STARTER"],
    ] as const) {
      it(`${from} -> ${to} is scheduled, and ${fromPlan} is kept until it is effective`, async () => {
        const { subscriptionId } = await givenSubscribed(from);
        const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;

        const response = await agent
          .post("/billing/change")
          .send({ priceKey: to })
          .expect(201);

        expect(response.body.effect).toBe("SCHEDULED");
        expect(response.body.kind).toBe("TIER_DOWNGRADE");
        expect(response.body.effectiveAt).toBe(periodEnd.toISOString());
        expect(response.body.plan).toBe(fromPlan);
        expect(await planOf()).toBe(fromPlan);
        expect(stripe.callCounts.get("updateSubscriptionPriceImmediately") ?? 0).toBe(0);

        const mirror = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(mirror.plan).toBe(fromPlan);
        expect(mirror.pendingPlan).toBe(toPlan);
        expect(mirror.pendingInterval).toBe(BILLING_CATALOG[to].interval);
        expect(mirror.pendingPriceId).toBe(PRICE_IDS[to]);
        expect(mirror.pendingEffectiveAt).toEqual(periodEnd);

        // Stripe's phase transition arrives.
        stripe.applyScheduledPhase(subscriptionId);
        await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
        expect(await planOf()).toBe(toPlan);

        const after = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(after.plan).toBe(toPlan);
        expect(after.pendingPlan).toBeNull();
      });
    }

    // Within one plan, a year is bought immediately (Stripe prorates the month already paid) and a
    // month waits for the end of the paid year — sections 7–9 of the decision document.
    for (const [from, to, plan] of [
      ["STARTER_MONTHLY", "STARTER_YEARLY", "STARTER"],
      ["PRO_MONTHLY", "PRO_YEARLY", "PRO"],
      ["PRO_PLUS_MONTHLY", "PRO_PLUS_YEARLY", "PRO_PLUS"],
    ] as const) {
      it(`${from} -> ${to} is an immediate cadence change at the same tier`, async () => {
        const { subscriptionId } = await givenSubscribed(from);
        const response = await agent
          .post("/billing/change")
          .send({ priceKey: to })
          .expect(201);

        expect(response.body).toMatchObject({
          kind: "CADENCE_LENGTHENED",
          effect: "IMMEDIATE",
          effectiveAt: null,
          plan,
        });
        expect(await planOf()).toBe(plan);
        expect(stripe.callCounts.get("updateSubscriptionPriceImmediately")).toBe(1);
        expect(stripe.callCounts.get("scheduleSubscriptionPriceChange") ?? 0).toBe(0);
        expect(stripe.subscriptions.get(subscriptionId)?.currentPriceId).toBe(PRICE_IDS[to]);

        const mirror = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(mirror).toMatchObject({
          plan,
          billingInterval: "YEAR",
          stripePriceId: PRICE_IDS[to],
          pendingPlan: null,
        });
      });
    }

    for (const [from, to, plan] of [
      ["STARTER_YEARLY", "STARTER_MONTHLY", "STARTER"],
      ["PRO_YEARLY", "PRO_MONTHLY", "PRO"],
      ["PRO_PLUS_YEARLY", "PRO_PLUS_MONTHLY", "PRO_PLUS"],
    ] as const) {
      it(`${from} -> ${to} waits for the end of the paid year at the same tier`, async () => {
        const { subscriptionId } = await givenSubscribed(from);
        const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;
        const response = await agent
          .post("/billing/change")
          .send({ priceKey: to })
          .expect(201);

        expect(response.body).toMatchObject({
          kind: "CADENCE_SHORTENED",
          effect: "SCHEDULED",
          effectiveAt: periodEnd.toISOString(),
          plan,
        });
        expect(stripe.callCounts.get("updateSubscriptionPriceImmediately") ?? 0).toBe(0);

        const mirror = await prisma.billingSubscription.findUniqueOrThrow({
          where: { userId },
        });
        expect(mirror).toMatchObject({
          plan,
          billingInterval: "YEAR",
          stripePriceId: PRICE_IDS[from],
          pendingPlan: plan,
          pendingInterval: "MONTH",
          pendingPriceId: PRICE_IDS[to],
          pendingEffectiveAt: periodEnd,
        });
        expect((await status()).subscription?.pendingChange).toEqual({
          plan,
          interval: "MONTH",
          effectiveAt: periodEnd.toISOString(),
        });

        // The year ends; the month begins.
        stripe.applyScheduledPhase(subscriptionId);
        await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
        expect(await planOf()).toBe(plan);
        expect(
          await prisma.billingSubscription.findUniqueOrThrow({ where: { userId } }),
        ).toMatchObject({
          billingInterval: "MONTH",
          stripePriceId: PRICE_IDS[to],
          pendingPlan: null,
        });
      });
    }

    it("an immediate tier upgrade from a year releases a scheduled move to monthly (BILL-01)", async () => {
      // Starter yearly → (scheduled) Starter monthly, then Pro monthly: left attached, the schedule
      // would move the upgraded subscription back to Starter at the end of the Starter year.
      const { subscriptionId } = await givenSubscribed("STARTER_YEARLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      expect((await status()).subscription?.pendingChange).toMatchObject({
        plan: "STARTER",
        interval: "MONTH",
      });

      await agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      expect(stripe.subscriptions.get(subscriptionId)).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_MONTHLY,
        scheduleId: null,
        scheduledPhase: null,
      });
      expect(await planOf()).toBe("PRO");
      expect((await status()).subscription?.pendingChange).toBeNull();
    });

    it("a year bought over a scheduled downgrade releases the downgrade (BILL-01)", async () => {
      // Pro monthly → (scheduled) Starter monthly, then a year of Pro: the customer pays for the year
      // and must not be moved to Starter at the old monthly boundary.
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_YEARLY" })
        .expect(201);
      expect(response.body).toMatchObject({ kind: "CADENCE_LENGTHENED", effect: "IMMEDIATE" });
      expect(stripe.subscriptions.get(subscriptionId)).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_YEARLY,
        scheduleId: null,
        scheduledPhase: null,
      });
      expect(await planOf()).toBe("PRO");
      expect((await status()).subscription?.pendingChange).toBeNull();
    });

    it("a year whose payment fails keeps the month already paid for", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_PLUS_MONTHLY");
      stripe.failNextImmediateChange = true;

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_PLUS_YEARLY" })
        .expect(201);
      expect(response.body.plan).toBe("PRO_PLUS");
      expect(stripe.subscriptions.get(subscriptionId)).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_PLUS_MONTHLY,
        pendingPriceId: PRICE_IDS.PRO_PLUS_YEARLY,
      });
      expect(
        await prisma.billingSubscription.findUniqueOrThrow({ where: { userId } }),
      ).toMatchObject({ billingInterval: "MONTH", stripePriceId: PRICE_IDS.PRO_PLUS_MONTHLY });
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
      const { subscriptionId } = await givenSubscribed("PRO_PLUS_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }).expect(201);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror.stripeScheduleId).not.toBeNull();
      expect(mirror.pendingPlan).toBe("PRO");
      expect(stripe.subscriptions.get(subscriptionId)?.scheduledPhase).toMatchObject({
        priceId: PRICE_IDS.PRO_MONTHLY,
      });
      expect(await planOf()).toBe("PRO_PLUS");
    });

    /**
     * Pre-release audit 2026-10-16, finding BILL-01 (`docs/audits/pre-release-audit-2026-10-16.md`),
     * reproduced in the Stripe sandbox (`billing-lifecycle.sandbox.test.ts`): the user paid $270 for
     * the then-sold PRO_YEARLY, the downgrade's schedule stayed attached, and at the old monthly
     * boundary Stripe moved the subscription to STARTER_MONTHLY with no credit. With one price per
     * tier the same path is Pro -> (scheduled) Starter, then Pro+: the customer pays the Pro+
     * proration and must still be on Pro+ when the downgrade's boundary arrives. The fake keeps a
     * schedule across an immediate update exactly as Stripe does, so only the release before the
     * update stops it.
     */
    it("an immediate upgrade releases a scheduled downgrade, so it can never apply (BILL-01)", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      expect(stripe.subscriptions.get(subscriptionId)?.scheduledPhase).not.toBeNull();
      expect((await status()).subscription?.pendingChange).toMatchObject({
        plan: "STARTER",
        interval: "MONTH",
      });

      const upgrade = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_PLUS_MONTHLY" })
        .expect(201);
      expect(upgrade.body).toMatchObject({
        effect: "IMMEDIATE",
        kind: "TIER_UPGRADE",
        plan: "PRO_PLUS",
      });

      // Released at Stripe, before the update. The boundary the downgrade was scheduled for is
      // still the next renewal, and when it arrives there is nothing left to apply.
      const live = stripe.subscriptions.get(subscriptionId)!;
      expect(live).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_PLUS_MONTHLY,
        currentPeriodEnd: periodEnd,
        scheduleId: null,
        scheduledPhase: null,
      });
      expect(() => stripe.applyScheduledPhase(subscriptionId)).toThrow(
        /no scheduled phase/,
      );
      expect(stripe.callCounts.get("releaseSubscriptionSchedule")).toBe(1);

      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect({
        plan: await planOf(),
        mirroredPlan: mirror.plan,
        pendingPlan: mirror.pendingPlan,
        pendingEffectiveAt: mirror.pendingEffectiveAt,
        stripeScheduleId: mirror.stripeScheduleId,
      }).toEqual({
        plan: "PRO_PLUS",
        mirroredPlan: "PRO_PLUS",
        pendingPlan: null,
        pendingEffectiveAt: null,
        stripeScheduleId: null,
      });
      expect((await status()).subscription?.pendingChange).toBeNull();
    });

    it("an upgrade whose payment fails grants nothing, and the downgrade it superseded stays released", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      stripe.failNextImmediateChange = true;

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_PLUS_MONTHLY" })
        .expect(201);
      expect(response.body.plan).toBe("PRO");

      // Stripe holds the unpaid update; the customer stays on the Pro price already paid for, with
      // no pending change — the newer request superseded the older one either way.
      const live = stripe.subscriptions.get(subscriptionId)!;
      expect(live).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_MONTHLY,
        pendingPriceId: PRICE_IDS.PRO_PLUS_MONTHLY,
        scheduleId: null,
      });
      const mirror = await prisma.billingSubscription.findUniqueOrThrow({
        where: { userId },
      });
      expect(mirror).toMatchObject({
        plan: "PRO",
        stripePriceId: PRICE_IDS.PRO_MONTHLY,
        pendingPlan: null,
        stripeScheduleId: null,
      });
      expect(await planOf()).toBe("PRO");

      // Once the held update is paid, Pro+ arrives.
      stripe.applyPendingUpdate(subscriptionId);
      await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(await planOf()).toBe("PRO_PLUS");
      expect(
        (await prisma.billingSubscription.findUniqueOrThrow({ where: { userId } }))
          .plan,
      ).toBe("PRO_PLUS");
    });

    it("bills nothing when the superseded schedule cannot be released", async () => {
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      stripe.failNextScheduleRelease = true;

      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "PRO_PLUS_MONTHLY" });
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(stripe.callCounts.get("updateSubscriptionPriceImmediately") ?? 0).toBe(0);
      // Exactly as before the request: still on Pro, the downgrade still scheduled.
      expect(await planOf()).toBe("PRO");
      expect(stripe.subscriptions.get(subscriptionId)).toMatchObject({
        currentPriceId: PRICE_IDS.PRO_MONTHLY,
        scheduledPhase: expect.objectContaining({ priceId: PRICE_IDS.STARTER_MONTHLY }),
      });
      expect((await status()).subscription?.pendingChange).toMatchObject({
        plan: "STARTER",
      });
    });

    it("can schedule the same change again after an upgrade released it", async () => {
      // Pro keeps its period end through a same-interval upgrade to Pro+, so asking for the same
      // downgrade again names the same subscription, price and boundary. A creation key derived from
      // those alone would make Stripe hand back the schedule the upgrade just released.
      const { subscriptionId } = await givenSubscribed("PRO_MONTHLY");
      const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      await agent.post("/billing/change").send({ priceKey: "PRO_PLUS_MONTHLY" }).expect(201);
      await agent.post("/billing/change").send({ priceKey: "STARTER_MONTHLY" }).expect(201);
      expect(stripe.subscriptions.get(subscriptionId)?.currentPeriodEnd).toEqual(periodEnd);

      const keys = stripe.idempotencyKeys
        .filter((entry) => entry.operation === "scheduleSubscriptionPriceChange")
        .map((entry) => entry.key);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      expect(stripe.subscriptions.get(subscriptionId)?.scheduledPhase).toMatchObject({
        priceId: PRICE_IDS.STARTER_MONTHLY,
      });
    });

    it("applies two simultaneous changes one after the other, each on live state", async () => {
      // Without serialization both requests read the same live snapshot and both classify from
      // Starter: two immediate upgrades from one starting price, so the customer is billed a
      // proration for each and ends on whichever update Stripe applied last — Pro, if that was the
      // Pro one, after paying for Pro+.
      const { subscriptionId } = await givenSubscribed("STARTER_MONTHLY");
      const periodEnd = stripe.subscriptions.get(subscriptionId)!.currentPeriodEnd;
      stripe.loadLatencyMs = 25;

      const [toPro, toProPlus] = await Promise.all([
        agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }),
        agent.post("/billing/change").send({ priceKey: "PRO_PLUS_MONTHLY" }),
      ]);
      expect([toPro.status, toProPlus.status]).toEqual([201, 201]);

      // Whichever ran second saw the first: Pro then Pro -> Pro+, or Pro+ then a Pro+ -> Pro
      // downgrade waiting for the end of the period paid for. Exactly one change ever left Starter.
      const updates = stripe.idempotencyKeys
        .filter((entry) => entry.operation === "updateSubscriptionPriceImmediately")
        .map((entry) => entry.key);
      expect(
        updates.filter((key) => key.includes(PRICE_IDS.STARTER_MONTHLY)),
      ).toHaveLength(1);

      const live = stripe.subscriptions.get(subscriptionId)!;
      expect(live.currentPriceId).toBe(PRICE_IDS.PRO_PLUS_MONTHLY);
      if (live.scheduledPhase) {
        expect(live.scheduledPhase).toEqual({
          priceId: PRICE_IDS.PRO_MONTHLY,
          startsAt: periodEnd,
        });
      }
      expect(await planOf()).toBe("PRO_PLUS");
    });

    it("refuses the second of two identical upgrades instead of billing it again", async () => {
      await givenSubscribed("STARTER_MONTHLY");
      stripe.loadLatencyMs = 25;

      const responses = await Promise.all([
        agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }),
        agent.post("/billing/change").send({ priceKey: "PRO_MONTHLY" }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(stripe.callCounts.get("updateSubscriptionPriceImmediately")).toBe(1);
      expect(await planOf()).toBe("PRO");
    });

    for (const priceKey of ALL_PRICE_KEYS) {
      it(`refuses a change to the price already held (${priceKey})`, async () => {
        await givenSubscribed(priceKey);
        const response = await agent
          .post("/billing/change")
          .send({ priceKey })
          .expect(409);
        expect(response.body.code).toBe("BILLING_CHANGE_NOT_ALLOWED");
        expect(stripe.callCounts.get("updateSubscriptionPriceImmediately") ?? 0).toBe(0);
        expect(stripe.callCounts.get("scheduleSubscriptionPriceChange") ?? 0).toBe(0);
      });
    }

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
      const { subscriptionId, customerId } = await givenSubscribed("STARTER_MONTHLY");
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
      const { subscriptionId, customerId } = await givenSubscribed("PRO_PLUS_MONTHLY");
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
      stripe.subscriptions.get(subscriptionId)!.currentPriceId = PRICE_IDS.PRO_MONTHLY;

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
        PRICE_IDS.STARTER_MONTHLY;
      await deliverWebhook(subscriptionEvent(subscriptionId, customerId)).expect(200);

      const [user, mirror] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } }),
        prisma.billingSubscription.findUniqueOrThrow({ where: { userId } }),
      ]);
      // The row justifying the plan and the plan itself always agree: they commit together.
      expect(user.plan).toBe("STARTER");
      expect(mirror.plan).toBe("STARTER");
      expect(mirror.stripePriceId).toBe(PRICE_IDS.STARTER_MONTHLY);
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
        priceId: PRICE_IDS.PRO_PLUS_MONTHLY,
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
        priceId: PRICE_IDS.PRO_PLUS_MONTHLY,
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
      stripe.seedSubscription({ customerId, priceId: PRICE_IDS.PRO_PLUS_MONTHLY });

      // No webhook at all — the outage case.
      expect(await planOf()).toBe("FREE");

      const result = await reconciliation.reconcileUser({ userId, trigger: "MANUAL" });
      expect(result.plan).toBe("PRO_PLUS");
      expect(result.planChanged).toBe(true);
      expect(await planOf()).toBe("PRO_PLUS");
    });

    it("is idempotent when run repeatedly", async () => {
      await givenSubscribed("STARTER_MONTHLY");
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
      expect(
        body.catalog.map((entry) => [
          entry.key,
          entry.plan,
          entry.interval,
          entry.amountMinorUnits,
          entry.currency,
        ]),
      ).toEqual([
        ["STARTER_MONTHLY", "STARTER", "MONTH", 1_900, "usd"],
        ["STARTER_YEARLY", "STARTER", "YEAR", 16_900, "usd"],
        ["PRO_MONTHLY", "PRO", "MONTH", 4_900, "usd"],
        ["PRO_YEARLY", "PRO", "YEAR", 43_900, "usd"],
        ["PRO_PLUS_MONTHLY", "PRO_PLUS", "MONTH", 19_900, "usd"],
        ["PRO_PLUS_YEARLY", "PRO_PLUS", "YEAR", 179_000, "usd"],
      ]);
    });

    it("reports a paid user's interval, renewal and management options", async () => {
      await givenSubscribed("PRO_PLUS_MONTHLY");
      const body = await status();

      expect(body.plan).toBe("PRO_PLUS");
      expect(body.subscription?.plan).toBe("PRO_PLUS");
      expect(body.subscription?.interval).toBe("MONTH");
      expect(body.subscription?.legacyPrice).toBe(false);
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
