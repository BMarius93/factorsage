import { randomUUID } from "node:crypto";
import type { StripeBillingConfig } from "@intrinsic/config";
import type { AuthUser, BillingPriceKey } from "@intrinsic/contracts";
import { createLogger } from "@intrinsic/observability";
import {
  BILLING_PERSONAS,
  BILLING_PERSONA_LIST,
  useTestDatabase,
  type BillingPersona,
  type BillingPersonaName,
} from "@intrinsic/testing";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { BillingCatalog } from "../billing/billing-catalog";
import { BillingReconciliationService } from "../billing/billing-reconciliation.service";
import { BillingService } from "../billing/billing.service";
import { FakeStripeFixtureGateway } from "../billing/stripe-fixture-gateway.test-helper";
import { FakeStripeGateway } from "../billing/stripe-gateway.test-helper";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import {
  billingPersonaClockName,
  billingPersonaFixtureMetadata,
} from "./billing-persona-fixtures";
import {
  BillingPersonaFixtureError,
  BillingPersonaRefusedError,
  cleanupBillingPersonaFixtures,
  inspectBillingPersona,
  seedBillingPersona,
  type BillingPersonaTooling,
} from "./billing-persona-tooling";

useTestDatabase();

/**
 * The billing persona tooling against real PostgreSQL and the **real**
 * `BillingReconciliationService`, with only Stripe replaced — by the product's own fake gateway
 * and the fixture fake built on it.
 *
 * So everything proven here about a mirror or a plan was produced by the application's
 * reconciliation: its lock, its transaction, `resolveEffectivePlan`, `changeUserPlan`. What the
 * tooling contributes, and what is under test, is how it builds the Stripe state, that a rerun
 * converges, that an interrupted run leaves no duplicates, and what a cleanup will and will not
 * touch. The opt-in `billing-personas.sandbox.test.ts` proves the same against real Stripe.
 *
 * Every case uses accounts of its own (`billing-it-<run>-<slug>@example.test`): the registry's
 * real addresses may be holding live-seeded personas in this same database, and this suite must
 * never disturb them.
 */

const PRICE_IDS: Record<BillingPriceKey, string> = {
  STARTER_MONTHLY: "price_fixture_starter_monthly",
  STARTER_YEARLY: "price_fixture_starter_yearly",
  PRO_MONTHLY: "price_fixture_pro_monthly",
  PRO_YEARLY: "price_fixture_pro_yearly",
};

const CONFIG: StripeBillingConfig = {
  secretKey: "sk_test_persona_tooling",
  webhookSecret: "whsec_persona_tooling",
  priceIds: PRICE_IDS,
  testMode: true,
  checkoutSuccessUrl: "http://localhost:3000/billing?checkout=success",
  checkoutCancelUrl: "http://localhost:3000/billing?checkout=cancelled",
  portalReturnUrl: "http://localhost:3000/billing",
  timeoutMs: 5_000,
  maxNetworkRetries: 0,
};

const logger = createLogger({
  service: "api",
  level: "silent",
  environment: "test",
  base: { component: "billing-persona-tooling-test" },
});

describe("billing QA persona tooling", () => {
  let prisma: PrismaService;
  let stripe: FakeStripeGateway;
  let fixtures: FakeStripeFixtureGateway;
  let billing: BillingService;
  let entitlements: EntitlementsService;
  let tooling: BillingPersonaTooling;
  let personas: Record<BillingPersonaName, BillingPersona>;
  let reconciled: string[];
  let sleeps: number[];
  let now: number;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    entitlements = new EntitlementsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    const run = randomUUID().slice(0, 8);
    personas = Object.fromEntries(
      BILLING_PERSONA_LIST.map((persona) => [
        persona.name,
        { ...persona, email: `billing-it-${run}-${persona.slug}@example.test` },
      ]),
    ) as Record<BillingPersonaName, BillingPersona>;

    stripe = new FakeStripeGateway({ webhookSecret: CONFIG.webhookSecret });
    fixtures = new FakeStripeFixtureGateway(stripe);
    const catalog = new BillingCatalog(CONFIG);
    const reconciliation = new BillingReconciliationService(
      prisma,
      logger,
      stripe,
      catalog,
    );
    billing = new BillingService(
      prisma,
      logger,
      reconciliation,
      stripe,
      catalog,
      CONFIG,
    );

    reconciled = [];
    sleeps = [];
    now = Date.parse("2026-10-10T12:00:00Z");
    tooling = {
      prisma,
      fixtures,
      catalog,
      // The real service. Only observed, so a case can say reconciliation ran.
      reconciliation: {
        reconcileUser: (input) => {
          reconciled.push(input.userId);
          return reconciliation.reconcileUser(input);
        },
      },
      hashPassword: async (password) => `hashed:${password}`,
      report: () => undefined,
      timing: {
        now: () => new Date(now),
        // Time passes only when the tooling waits, so nothing here waits on a real clock.
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
        clockPollIntervalMs: 1_000,
        clockTimeoutMs: 60_000,
      },
      createdBy: "billing-persona-tooling.integration.test",
    };
  });

  afterEach(async () => {
    // The mirror and the acceptance records cascade with the account.
    await prisma.user.deleteMany({
      where: {
        email: { in: Object.values(personas).map((persona) => persona.email) },
      },
    });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function accountOf(persona: BillingPersona) {
    return prisma.user.findUniqueOrThrow({
      where: { email: persona.email },
      include: { billingSubscription: true },
    });
  }

  async function authUserOf(persona: BillingPersona): Promise<AuthUser> {
    const account = await accountOf(persona);
    return {
      id: account.id,
      email: account.email,
      role: account.role,
      plan: account.plan,
    };
  }

  function clocksOf(userId: string): string[] {
    return [...fixtures.clocks.values()]
      .filter((clock) => clock.name.endsWith(`/${userId}`))
      .map((clock) => clock.id);
  }

  /**
   * Subscriptions of customers Stripe still has. Deleting a fixture cancels its subscription and
   * leaves it listed under the deleted customer, so "how many subscriptions exist" is asked of the
   * customers that do.
   */
  function subscriptionsOfLiveCustomers(): string[] {
    return [...stripe.subscriptions.values()]
      .filter(
        (subscription) =>
          stripe.customers.get(subscription.customerId)?.deleted === false,
      )
      .map((subscription) => subscription.id);
  }

  const seed = (name: BillingPersonaName) =>
    seedBillingPersona(tooling, personas[name], { password: null });

  // -------------------------------------------------------------------------
  // Each persona, end to end
  // -------------------------------------------------------------------------

  describe.each(BILLING_PERSONA_LIST.map((persona) => persona.name))(
    "%s",
    (name) => {
      const declared = BILLING_PERSONAS[name];

      it("reaches its declared Stripe state and reconciles to its declared plan", async () => {
        const persona = personas[name];
        const result = await seed(name);

        expect(result.problems).toEqual([]);
        expect(result.stripe).toBe("CREATED");

        // Stripe's side: one subscription, on the configured price, in the declared status.
        expect(result.subscription.status).toBe(declared.expected.stripeStatus);
        expect(result.subscription.priceId).toBe(PRICE_IDS[declared.priceKey]);
        expect(result.subscription.metadata).toMatchObject(
          billingPersonaFixtureMetadata(
            { persona: name, ownerUserId: result.userId },
            tooling.createdBy,
          ),
        );
        expect(clocksOf(result.userId)).toHaveLength(1);

        // FactorSage's side, as persisted — every expectation a literal from the registry.
        const account = await accountOf(persona);
        expect(account.plan).toBe(declared.expected.userPlan);
        expect(account.role).toBe("USER");
        expect(account.emailVerifiedAt).not.toBeNull();
        expect(account.stripeCustomerId).toBe(result.customerId);

        const mirror = account.billingSubscription;
        expect(mirror).not.toBeNull();
        expect(mirror?.status).toBe(declared.expected.mirrorStatus);
        expect(mirror?.planReason).toBe(declared.expected.planReason);
        expect(mirror?.plan).toBe(declared.subscribedPlan);
        expect(mirror?.billingInterval).toBe(declared.interval);
        expect(mirror?.stripePriceId).toBe(PRICE_IDS[declared.priceKey]);
        expect(mirror?.stripeSubscriptionId).toBe(result.subscription.id);

        // It got there through reconciliation, and through nothing else.
        expect(reconciled).toContain(result.userId);
      });

      it("is reported the same way by the billing status route's service", async () => {
        const persona = personas[name];
        await seed(name);

        const status = await billing.readStatus(await authUserOf(persona));
        expect(status.plan).toBe(declared.expected.userPlan);
        expect(status.subscription?.status).toBe(
          declared.expected.mirrorStatus,
        );
        expect(status.subscription?.plan).toBe(declared.subscribedPlan);
        expect(status.subscription?.interval).toBe(declared.interval);
        // A subscription that still holds the paid slot blocks a second Checkout; an ended one
        // releases it, so a lapsed customer can subscribe again.
        expect(status.canStartCheckout).toBe(!declared.expected.holdsPaidSlot);
        expect(status.canChangePlan).toBe(declared.expected.holdsPaidSlot);
        expect(status.canOpenPortal).toBe(true);
        if (declared.expected.holdsPaidSlot) {
          expect(status.subscription?.cancelAtPeriodEnd).toBe(
            declared.expected.cancellationScheduled,
          );
        }
        // No Stripe identifier crosses the status boundary.
        expect(JSON.stringify(status)).not.toMatch(/cus_|sub_|price_|clock_/);
      });

      it("has exactly the entitlements of its reconciled plan", async () => {
        const persona = personas[name];
        await seed(name);

        expect(
          entitlements.entitlementsOf(await authUserOf(persona)).tier,
        ).toBe(declared.expected.userPlan);
      });

      it("is left alone by a second run, which writes nothing to Stripe", async () => {
        const first = await seed(name);
        const writes = fixtures.writes.length;
        const reconciliations = reconciled.length;

        const second = await seed(name);

        expect(second.stripe).toBe("REUSED");
        expect(second.problems).toEqual([]);
        expect(second.subscription.id).toBe(first.subscription.id);
        expect(second.customerId).toBe(first.customerId);
        expect(fixtures.writes.length).toBe(writes);
        expect(clocksOf(first.userId)).toHaveLength(1);
        // Reconciliation still runs: a rerun also repairs FactorSage's side.
        expect(reconciled.length).toBe(reconciliations + 1);
      });

      it("is CONVERGED to the status command", async () => {
        await seed(name);
        const status = await inspectBillingPersona(tooling, personas[name]);
        expect(status.problems).toEqual([]);
        expect(status.verdict).toBe("CONVERGED");
      });
    },
  );

  // -------------------------------------------------------------------------
  // What each lifecycle is made of
  // -------------------------------------------------------------------------

  describe("lifecycles", () => {
    it("schedules a cancellation in the representation Customer Portal produces", async () => {
      const result = await seed("BILLING_PRO_CANCELING");

      // `cancel_at` carries the period end and the raw flag stays false.
      expect(result.subscription.cancelAtPeriodEnd).toBe(false);
      expect(result.subscription.cancelAt).toEqual(
        result.subscription.currentPeriodEnd,
      );
      // …and reconciliation still recognises it, which is what `hasScheduledCancellation` is for.
      expect(result.local.mirror?.cancelAtPeriodEnd).toBe(true);
      expect(result.local.mirror?.cancelAt).toEqual(
        result.subscription.cancelAt,
      );
      expect(result.local.plan).toBe("PRO");
    });

    it("refuses a plan change for the canceling persona, as the product does", async () => {
      await seed("BILLING_PRO_CANCELING");
      await expect(
        billing.changePlan({
          user: await authUserOf(personas.BILLING_PRO_CANCELING),
          priceKey: "STARTER_MONTHLY",
          requestId: "test",
        }),
      ).rejects.toMatchObject({
        detail: { code: "BILLING_CHANGE_NOT_ALLOWED" },
      });
    });

    it("reaches past_due by failing a real renewal, not by setting a status", async () => {
      const result = await seed("BILLING_STARTER_PAST_DUE");

      // A failing payment method was attached and the clock crossed the period end.
      expect(
        fixtures.writes
          .map((write) => write.operation)
          .filter((operation) =>
            [
              "attachTestPaymentMethod",
              "setSubscriptionPaymentMethod",
              "advanceTestClock",
            ].includes(operation),
          ),
      ).toEqual([
        "attachTestPaymentMethod",
        "attachTestPaymentMethod",
        "setSubscriptionPaymentMethod",
        "advanceTestClock",
      ]);
      // Access is kept through Stripe's retry window.
      expect(result.local.plan).toBe("STARTER");
      expect(result.local.mirror?.status).toBe("PAST_DUE");
    });

    it("ends the canceled persona's subscription by letting its paid period run out", async () => {
      const result = await seed("BILLING_CANCELED");

      expect(fixtures.countOf("scheduleCancellationAtPeriodEnd")).toBe(1);
      expect(fixtures.countOf("advanceTestClock")).toBe(1);
      // The exact shape the reconciler defines for an ended subscription: FREE, with the ended
      // subscription still mirrored — on the plan it was — so the page can say why access ended.
      expect(result.local.plan).toBe("FREE");
      expect(result.local.mirror?.status).toBe("CANCELED");
      expect(result.local.mirror?.plan).toBe("PRO");
      expect(result.local.mirror?.planReason).toBe("SUBSCRIPTION_TERMINATED");
      expect(result.local.mirror?.canceledAt).not.toBeNull();
    });

    it("tags every Stripe object it creates, and names the clock for its owner", async () => {
      const result = await seed("BILLING_STARTER_PAST_DUE");
      const identity = {
        persona: "BILLING_STARTER_PAST_DUE",
        ownerUserId: result.userId,
      };
      const tags = billingPersonaFixtureMetadata(identity, tooling.createdBy);

      // The customer, the subscription, and both payment methods.
      expect(
        fixtures.fixtureCustomers.get(result.customerId)?.metadata,
      ).toEqual(tags);
      expect(fixtures.subscriptionMetadata.get(result.subscription.id)).toEqual(
        tags,
      );
      expect([...fixtures.paymentMethodMetadata.values()]).toEqual([
        tags,
        tags,
      ]);
      // A Test Clock carries no metadata, so its name says the same thing.
      expect([...fixtures.clocks.values()].map((clock) => clock.name)).toEqual([
        billingPersonaClockName(identity),
      ]);
    });

    it("starts a boundary lifecycle in the past, so its dates are not in the future", async () => {
      const result = await seed("BILLING_CANCELED");
      const clock = [...fixtures.clocks.values()].find((candidate) =>
        candidate.name.endsWith(`/${result.userId}`),
      );
      expect(clock?.frozenTime.getTime()).toBeLessThan(now);
    });

    it("polls a clock until Stripe reports it ready instead of assuming it advanced", async () => {
      fixtures.readsWhileAdvancing = 4;

      const result = await seed("BILLING_STARTER_PAST_DUE");

      expect(result.problems).toEqual([]);
      // One wait per read that still said `advancing`.
      expect(sleeps).toEqual([1_000, 1_000, 1_000, 1_000]);
    });

    it("advances further when the renewal invoice has not been finalised yet", async () => {
      // Stripe attempts the charge only once the invoice is finalised; here that takes longer
      // than the first advance allows for.
      fixtures.renewalFinalizationMs = 3.5 * 3_600_000;

      const result = await seed("BILLING_STARTER_PAST_DUE");

      expect(result.subscription.status).toBe("past_due");
      expect(fixtures.countOf("advanceTestClock")).toBe(3);
    });

    it("gives up, loudly, when Stripe never reaches the declared state", async () => {
      fixtures.renewalFinalizationMs = 365 * 86_400_000;
      await expect(seed("BILLING_STARTER_PAST_DUE")).rejects.toThrow(
        BillingPersonaFixtureError,
      );
    });

    it("gives up when a clock never finishes advancing", async () => {
      fixtures.readsWhileAdvancing = Number.MAX_SAFE_INTEGER;
      await expect(seed("BILLING_CANCELED")).rejects.toThrow(
        /still advancing after 60 s/,
      );
    });

    it("uses a different idempotency key for every write of one build", async () => {
      await seed("BILLING_STARTER_PAST_DUE");
      const keys = fixtures.writes
        .map((write) => write.idempotencyKey)
        .filter((key): key is string => key !== null);

      expect(keys.length).toBeGreaterThanOrEqual(5);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(key).toMatch(
          /^factorsage-qa:billing-persona:BILLING_STARTER_PAST_DUE:/,
        );
      }
    });

    it("never reuses a build's idempotency keys in the next build", async () => {
      await seed("BILLING_PRO_ACTIVE");
      const first = new Set(
        fixtures.writes.map((write) => write.idempotencyKey),
      );

      // Drift forces a rebuild.
      const subscription = [...stripe.subscriptions.values()][0];
      if (!subscription) {
        throw new Error("expected a subscription");
      }
      stripe.setStatus(subscription.id, "unpaid");
      const before = fixtures.writes.length;
      await seed("BILLING_PRO_ACTIVE");

      const second = fixtures.writes
        .slice(before)
        .map((write) => write.idempotencyKey)
        .filter((key): key is string => key !== null);
      expect(second.length).toBeGreaterThan(0);
      // A replayed key would hand back the first build's now-deleted objects.
      expect(second.some((key) => first.has(key))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  describe("recovery", () => {
    it.each([
      "createTestClockCustomer",
      "attachTestPaymentMethod",
      "createSubscription",
      "scheduleCancellationAtPeriodEnd",
      "advanceTestClock",
    ])(
      "leaves no duplicate after a run interrupted at %s",
      async (operation) => {
        fixtures.failNext = operation;
        await expect(seed("BILLING_CANCELED")).rejects.toThrow(
          /simulated outage/,
        );

        const account = await accountOf(personas.BILLING_CANCELED);
        // The half-built fixture is still there, findable by its name.
        expect(clocksOf(account.id)).toHaveLength(1);

        const result = await seed("BILLING_CANCELED");

        expect(result.problems).toEqual([]);
        expect(result.stripe).toBe("REBUILT");
        // Exactly one clock, one customer and one subscription — not two.
        expect(clocksOf(account.id)).toHaveLength(1);
        expect(
          [...fixtures.fixtureCustomers.values()].filter(
            (customer) => customer.email === personas.BILLING_CANCELED.email,
          ),
        ).toHaveLength(1);
        expect(
          [...stripe.subscriptions.values()].filter(
            (subscription) => subscription.customerId === result.customerId,
          ),
        ).toHaveLength(1);
        expect(subscriptionsOfLiveCustomers()).toHaveLength(1);
      },
    );

    it("finishes a run that stopped while its clock was still advancing", async () => {
      // The first run times out waiting; the clock goes on advancing without it.
      fixtures.readsWhileAdvancing = 100;
      await expect(seed("BILLING_STARTER_PAST_DUE")).rejects.toThrow(
        /still advancing/,
      );
      const creates = fixtures.countOf("createSubscription");

      fixtures.readsWhileAdvancing = 0;
      // Let the abandoned advance complete on the fake's side.
      for (const clock of fixtures.clocks.values()) {
        clock.readsUntilReady = 0;
      }
      const result = await seed("BILLING_STARTER_PAST_DUE");

      // It waited for the clock, found the lifecycle had arrived, and built nothing new.
      expect(result.stripe).toBe("REUSED");
      expect(result.problems).toEqual([]);
      expect(fixtures.countOf("createSubscription")).toBe(creates);
    });

    it("rebuilds a fixture that drifted from its declared state, and says why", async () => {
      const first = await seed("BILLING_PRO_ACTIVE");
      stripe.scheduleCancellation(first.subscription.id);

      const status = await inspectBillingPersona(
        tooling,
        personas.BILLING_PRO_ACTIVE,
      );
      expect(status.verdict).toBe("STRIPE_DRIFT");
      expect(status.problems).toEqual(["a cancellation is scheduled"]);

      const second = await seed("BILLING_PRO_ACTIVE");

      expect(second.stripe).toBe("REBUILT");
      expect(second.rebuildReasons).toEqual(["a cancellation is scheduled"]);
      expect(second.subscription.id).not.toBe(first.subscription.id);
      expect(second.problems).toEqual([]);
      expect(clocksOf(second.userId)).toHaveLength(1);
      expect(subscriptionsOfLiveCustomers()).toEqual([second.subscription.id]);
      // The mirror follows the new subscription rather than gaining a second row.
      const account = await accountOf(personas.BILLING_PRO_ACTIVE);
      expect(account.billingSubscription?.stripeSubscriptionId).toBe(
        second.subscription.id,
      );
      expect(account.plan).toBe("PRO");
    });

    it("replaces duplicates with one fixture", async () => {
      const first = await seed("BILLING_PRO_ACTIVE");
      // A second fixture for the same persona and owner, as two racing runs could leave.
      const identity = {
        persona: "BILLING_PRO_ACTIVE",
        ownerUserId: first.userId,
      };
      const duplicate = await fixtures.createTestClock({
        name: billingPersonaClockName(identity),
        frozenTime: new Date(now),
        idempotencyKey: "duplicate",
      });
      expect(clocksOf(first.userId)).toHaveLength(2);

      const second = await seed("BILLING_PRO_ACTIVE");

      expect(second.stripe).toBe("REBUILT");
      expect(clocksOf(first.userId)).toHaveLength(1);
      expect(fixtures.clocks.has(duplicate.id)).toBe(false);
      expect(second.problems).toEqual([]);
    });

    it("repairs FactorSage's side when only the plan was changed by hand", async () => {
      await seed("BILLING_PRO_ACTIVE");
      const account = await accountOf(personas.BILLING_PRO_ACTIVE);
      // Simulated tampering — the one direct plan write in this file, and it is the test's.
      await prisma.user.update({
        where: { id: account.id },
        data: { plan: "FREE" },
      });

      const status = await inspectBillingPersona(
        tooling,
        personas.BILLING_PRO_ACTIVE,
      );
      expect(status.verdict).toBe("LOCAL_DRIFT");
      expect(status.problems).toEqual(["User.plan is FREE, expected PRO"]);

      const writes = fixtures.writes.length;
      const result = await seed("BILLING_PRO_ACTIVE");

      expect(result.stripe).toBe("REUSED");
      expect(fixtures.writes.length).toBe(writes);
      expect((await accountOf(personas.BILLING_PRO_ACTIVE)).plan).toBe("PRO");
    });

    it("replaces a link to a Stripe customer that no longer exists", async () => {
      const first = await seed("BILLING_PRO_ACTIVE");
      // What Stripe does about thirty days after a Test Clock is created.
      const [clockId] = clocksOf(first.userId);
      await fixtures.deleteTestClock(clockId as string);

      const status = await inspectBillingPersona(
        tooling,
        personas.BILLING_PRO_ACTIVE,
      );
      expect(status.verdict).toBe("STALE_LINK");

      // Left alone, the account does not break. Stripe cancelled the deleted customer's
      // subscription and still lists it, so the next reconciliation takes the account to FREE —
      // with a mirror and a link that describe a customer that no longer exists.
      await tooling.reconciliation.reconcileUser({
        userId: first.userId,
        trigger: "MANUAL",
      });
      const lapsed = await accountOf(personas.BILLING_PRO_ACTIVE);
      expect(lapsed.plan).toBe("FREE");
      expect(lapsed.billingSubscription?.status).toBe("CANCELED");
      expect(lapsed.stripeCustomerId).toBe(first.customerId);

      const second = await seed("BILLING_PRO_ACTIVE");

      expect(second.stripe).toBe("CREATED");
      expect(second.customerId).not.toBe(first.customerId);
      expect(second.problems).toEqual([]);
      expect(
        (await accountOf(personas.BILLING_PRO_ACTIVE)).stripeCustomerId,
      ).toBe(second.customerId);
    });

    it("sets a password only when one is supplied, and never touches the plan doing so", async () => {
      await seed("BILLING_PRO_ACTIVE");
      const before = await accountOf(personas.BILLING_PRO_ACTIVE);
      expect(before.passwordHash).toBeNull();

      await seedBillingPersona(tooling, personas.BILLING_PRO_ACTIVE, {
        password: "a-long-enough-password",
      });
      const after = await accountOf(personas.BILLING_PRO_ACTIVE);
      expect(after.passwordHash).toBe("hashed:a-long-enough-password");
      expect(after.id).toBe(before.id);
      expect(after.plan).toBe("PRO");

      // And a later run without one keeps it.
      await seed("BILLING_PRO_ACTIVE");
      expect((await accountOf(personas.BILLING_PRO_ACTIVE)).passwordHash).toBe(
        "hashed:a-long-enough-password",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  describe("refusals", () => {
    it("refuses to seed over a fixture that has lost its metadata", async () => {
      const first = await seed("BILLING_PRO_ACTIVE");
      const customer = fixtures.fixtureCustomers.get(first.customerId);
      if (!customer) {
        throw new Error("expected the fixture customer");
      }
      customer.metadata = {};
      const writes = fixtures.writes.length;

      await expect(seed("BILLING_PRO_ACTIVE")).rejects.toThrow(
        BillingPersonaRefusedError,
      );

      // Neither reused nor replaced: nothing was written and the clock is still there.
      expect(fixtures.writes.length).toBe(writes);
      expect(clocksOf(first.userId)).toHaveLength(1);
      const status = await inspectBillingPersona(
        tooling,
        personas.BILLING_PRO_ACTIVE,
      );
      expect(status.verdict).toBe("AMBIGUOUS");
    });

    it("refuses to re-point an account linked to a customer the tooling did not create", async () => {
      // The persona was taken through real Checkout by hand: an ordinary application customer.
      await seed("BILLING_PRO_ACTIVE");
      const account = await accountOf(personas.BILLING_PRO_ACTIVE);
      await cleanupBillingPersonaFixtures(tooling, {
        scope: "DATABASE",
        dryRun: false,
        personas: [personas.BILLING_PRO_ACTIVE],
      });
      const foreign = stripe.seedCustomer(account.id);
      await prisma.user.update({
        where: { id: account.id },
        data: { stripeCustomerId: foreign },
      });
      const writes = fixtures.writes.length;

      await expect(seed("BILLING_PRO_ACTIVE")).rejects.toThrow(
        /not one of this tooling's fixtures/,
      );
      expect(fixtures.writes.length).toBe(writes);
      expect(
        (await accountOf(personas.BILLING_PRO_ACTIVE)).stripeCustomerId,
      ).toBe(foreign);
    });

    it("leaves the other personas alone when one is refused", async () => {
      const active = await seed("BILLING_PRO_ACTIVE");
      const canceling = await seed("BILLING_PRO_CANCELING");
      const customer = fixtures.fixtureCustomers.get(active.customerId);
      if (!customer) {
        throw new Error("expected the fixture customer");
      }
      customer.metadata = {};

      await expect(seed("BILLING_PRO_ACTIVE")).rejects.toThrow(
        BillingPersonaRefusedError,
      );
      // An ambiguous fixture of one persona is not a reason to refuse another.
      const again = await seed("BILLING_PRO_CANCELING");
      expect(again.stripe).toBe("REUSED");
      expect(again.subscription.id).toBe(canceling.subscription.id);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    const cleanup = (
      options: { scope?: "DATABASE" | "ALL_TAGGED"; dryRun?: boolean } = {},
    ) =>
      cleanupBillingPersonaFixtures(tooling, {
        scope: options.scope ?? "DATABASE",
        dryRun: options.dryRun ?? false,
        personas: Object.values(personas),
      });

    it("removes the fixtures and takes each account to FREE through reconciliation", async () => {
      const active = await seed("BILLING_PRO_ACTIVE");
      const pastDue = await seed("BILLING_STARTER_PAST_DUE");
      reconciled.length = 0;

      const result = await cleanup();

      expect(result.refusals).toEqual([]);
      expect(result.fixtures.map((fixture) => fixture.persona).sort()).toEqual([
        "BILLING_PRO_ACTIVE",
        "BILLING_STARTER_PAST_DUE",
      ]);
      expect(fixtures.clocks.size).toBe(0);
      expect(subscriptionsOfLiveCustomers()).toEqual([]);

      for (const persona of [
        personas.BILLING_PRO_ACTIVE,
        personas.BILLING_STARTER_PAST_DUE,
      ]) {
        const account = await accountOf(persona);
        // The account survives, as an ordinary FREE account with no billing state at all.
        expect(account.plan).toBe("FREE");
        expect(account.stripeCustomerId).toBeNull();
        expect(account.billingSubscription).toBeNull();
      }
      // Both got there through the reconciler, before their Stripe customer was deleted.
      expect(reconciled.sort()).toEqual([active.userId, pastDue.userId].sort());
    });

    it("deletes nothing on a dry run", async () => {
      await seed("BILLING_PRO_ACTIVE");
      const writes = fixtures.writes.length;

      const result = await cleanup({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.fixtures).toHaveLength(1);
      expect(fixtures.writes.length).toBe(writes);
      expect(fixtures.clocks.size).toBe(1);
      expect((await accountOf(personas.BILLING_PRO_ACTIVE)).plan).toBe("PRO");
    });

    it("never touches a Test Clock somebody else created", async () => {
      await seed("BILLING_PRO_ACTIVE");
      const manual = fixtures.seedForeignClock({ name: "manual renewal test" });
      const taggedButForeign = fixtures.seedForeignClock({
        name: "another tool's clock",
        // Even a customer carrying this tooling's tags does not make the clock ours.
        customerMetadata: billingPersonaFixtureMetadata(
          { persona: "BILLING_PRO_ACTIVE", ownerUserId: randomUUID() },
          "somebody else",
        ),
      });

      const result = await cleanup({ scope: "ALL_TAGGED" });

      expect(result.fixtures).toHaveLength(1);
      expect(result.refusals).toEqual([]);
      expect(fixtures.clocks.has(manual.clockId)).toBe(true);
      expect(fixtures.clocks.has(taggedButForeign.clockId)).toBe(true);
      expect(fixtures.clocks.size).toBe(2);
    });

    it("leaves another owner's fixture alone unless asked for every tagged one", async () => {
      await seed("BILLING_PRO_ACTIVE");
      // The same persona, seeded from another database: a different user id owns it.
      const other = {
        ...personas.BILLING_PRO_ACTIVE,
        email: `other-${personas.BILLING_PRO_ACTIVE.email}`,
      };
      const theirs = await seedBillingPersona(tooling, other, {
        password: null,
      });
      try {
        const scoped = await cleanup();
        expect(scoped.fixtures).toHaveLength(1);
        expect(scoped.outOfScope).toBe(1);
        expect(clocksOf(theirs.userId)).toHaveLength(1);
        // Their account was not detached either.
        expect((await accountOf(other)).plan).toBe("PRO");

        const everything = await cleanup({ scope: "ALL_TAGGED" });
        expect(
          everything.fixtures.map((fixture) => fixture.ownerUserId),
        ).toEqual([theirs.userId]);
        expect(fixtures.clocks.size).toBe(0);
        expect((await accountOf(other)).plan).toBe("FREE");
      } finally {
        await prisma.user.deleteMany({ where: { email: other.email } });
      }
    });

    it("refuses an ambiguous fixture, reports it, and still removes the rest", async () => {
      const active = await seed("BILLING_PRO_ACTIVE");
      const canceling = await seed("BILLING_PRO_CANCELING");
      // Somebody added a subscription to the fixture customer by hand.
      stripe.seedSubscription({
        customerId: active.customerId,
        priceId: PRICE_IDS.STARTER_MONTHLY,
        id: "sub_added_by_hand",
      });

      const result = await cleanup();

      expect(result.fixtures.map((fixture) => fixture.persona)).toEqual([
        "BILLING_PRO_CANCELING",
      ]);
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]).toMatch(
        /sub_added_by_hand: metadata .* is missing/,
      );
      // The refused fixture and its account are exactly as they were.
      expect(clocksOf(active.userId)).toHaveLength(1);
      expect((await accountOf(personas.BILLING_PRO_ACTIVE)).plan).toBe("PRO");
      expect(clocksOf(canceling.userId)).toHaveLength(0);
    });

    it("refuses a fixture that stopped being provably ours between the listing and the delete", async () => {
      const active = await seed("BILLING_PRO_ACTIVE");
      // The plan is made from a listing; the delete re-reads the clock first. Between the two,
      // the customer loses its tags.
      const retrieve = fixtures.retrieveTestClock.bind(fixtures);
      fixtures.retrieveTestClock = async (clockId) => {
        const customer = fixtures.fixtureCustomers.get(active.customerId);
        if (customer) {
          customer.metadata = {};
        }
        return retrieve(clockId);
      };

      const result = await cleanup();

      expect(result.fixtures).toEqual([]);
      expect(result.refusals.join(" ")).toMatch(
        /no longer reads as this tooling's fixture/,
      );
      expect(clocksOf(active.userId)).toHaveLength(1);
      expect(fixtures.countOf("deleteTestClock")).toBe(0);
    });

    it("clears a stale link, and leaves a link to a customer that is not ours", async () => {
      const stale = await seed("BILLING_PRO_ACTIVE");
      const [clockId] = clocksOf(stale.userId);
      await fixtures.deleteTestClock(clockId as string);

      await seed("BILLING_PRO_CANCELING");
      const canceling = await accountOf(personas.BILLING_PRO_CANCELING);
      const [cancelingClock] = clocksOf(canceling.id);
      await fixtures.deleteTestClock(cancelingClock as string);
      const foreign = stripe.seedCustomer(canceling.id);
      await prisma.user.update({
        where: { id: canceling.id },
        data: { stripeCustomerId: foreign },
      });

      const result = await cleanup();

      expect(result.staleLinks).toEqual([personas.BILLING_PRO_ACTIVE.email]);
      const repaired = await accountOf(personas.BILLING_PRO_ACTIVE);
      expect(repaired.stripeCustomerId).toBeNull();
      expect(repaired.plan).toBe("FREE");
      expect(repaired.billingSubscription).toBeNull();

      expect(result.refusals.join(" ")).toMatch(
        /not one of this tooling's fixtures/,
      );
      expect(
        (await accountOf(personas.BILLING_PRO_CANCELING)).stripeCustomerId,
      ).toBe(foreign);
    });

    it("can be followed by a fresh seed", async () => {
      await seed("BILLING_CANCELED");
      await cleanup();

      const result = await seed("BILLING_CANCELED");
      expect(result.stripe).toBe("CREATED");
      expect(result.problems).toEqual([]);
    });
  });
});
