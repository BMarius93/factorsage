import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getStripeBillingConfig,
  type StripeBillingConfig,
} from "@intrinsic/config";
import {
  BILLING_CATALOG,
  findBillingPriceKey,
  type AuthUser,
  type BillingPriceKey,
} from "@intrinsic/contracts";
import { createLogger } from "@intrinsic/observability";
import {
  BILLING_PERSONAS,
  useTestDatabase,
  type BillingPersona,
} from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import {
  assertBillingPersonaStripeConfig,
  resolveBillingPersonaDatabase,
} from "../billing-personas/billing-persona-environment";
import {
  DEFAULT_BILLING_PERSONA_TIMING,
  cleanupBillingPersonaFixtures,
  seedBillingPersona,
  type BillingPersonaTooling,
} from "../billing-personas/billing-persona-tooling";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { BillingCatalog } from "./billing-catalog";
import { BillingReconciliationService } from "./billing-reconciliation.service";
import { BillingModule } from "./billing.module";
import { BillingService } from "./billing.service";
import { BILLING_CATALOG_TOKEN, STRIPE_GATEWAY } from "./billing.tokens";
import type { StripeGateway } from "./stripe-gateway";
import { StripeTestModeFixtureGateway } from "./stripe.gateway";

/**
 * Billing lifecycles against **real Stripe test mode**, written for the pre-release audit of
 * 2026-10-16 (`docs/audits/pre-release-audit-2026-10-16.md`, BILL-01 and the sandbox section).
 *
 * Each scenario drives the product's own `BillingService` and `BillingReconciliationService` over a
 * throwaway account on its own Test Clock — built by the billing-persona tooling, so the only way a
 * subscription exists is the way the personas' do — and records what Stripe and FactorSage hold at
 * every step to `.debug/billing-sandbox/<scenario>.json`. Webhooks are not delivered here:
 * reconciliation is asked directly, which is the outcome a delivered webhook converges on.
 *
 * Opt-in (`STRIPE_BILLING_AUDIT=true`), excluded from `pnpm test`, test-mode keys and the local test
 * database only (the persona tooling's refusals run first). Every Test Clock it creates is deleted
 * at the end, which cancels the clock's subscription and removes its customer.
 */

const ENABLED = process.env.STRIPE_BILLING_AUDIT?.trim() === "true";

if (ENABLED) {
  useTestDatabase();
}

/** Leaves the scratch fixtures in Stripe and records their ids, for inspecting invoices by hand. */
const KEEP_FIXTURES =
  process.env.STRIPE_BILLING_AUDIT_KEEP_FIXTURES?.trim() === "true";

const STRIPE_TIMEOUT_MS = 15 * 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEARLY_KEYS = [
  "STARTER_YEARLY",
  "PRO_YEARLY",
  "PRO_PLUS_YEARLY",
] as const satisfies readonly BillingPriceKey[];
const EVIDENCE_DIR = join(__dirname, "../../../../.debug/billing-sandbox");

type Observation = Record<string, unknown> & { step: string };

describe.skipIf(!ENABLED)(
  "billing lifecycles against the Stripe sandbox",
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let stripe: StripeGateway;
    let billing: BillingService;
    let reconciliation: BillingReconciliationService;
    let tooling: BillingPersonaTooling;
    let config: StripeBillingConfig;
    const scratch: BillingPersona[] = [];

    beforeAll(async () => {
      config = assertBillingPersonaStripeConfig(getStripeBillingConfig());
      resolveBillingPersonaDatabase("test");
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigurationModule,
          DatabaseModule,
          AuthModule,
          EntitlementsModule,
          BillingModule,
        ],
      }).compile();
      app = moduleRef.createNestApplication({ rawBody: true });
      await app.init();
      prisma = app.get(PrismaService);
      stripe = app.get<StripeGateway>(STRIPE_GATEWAY);
      billing = app.get(BillingService);
      reconciliation = app.get(BillingReconciliationService);
      const passwords = app.get(PasswordService);
      tooling = {
        prisma,
        fixtures: new StripeTestModeFixtureGateway(
          config,
          createLogger({
            service: "api",
            level: "warn",
            environment: "test",
            base: { component: "stripe-fixtures" },
          }),
        ),
        catalog: app.get<BillingCatalog>(BILLING_CATALOG_TOKEN),
        reconciliation,
        hashPassword: (value) => passwords.hash(value),
        report: () => undefined,
        timing: DEFAULT_BILLING_PERSONA_TIMING,
        createdBy: "pre-release audit billing lifecycles",
      };
      mkdirSync(EVIDENCE_DIR, { recursive: true });
    }, STRIPE_TIMEOUT_MS);

    afterAll(async () => {
      if (KEEP_FIXTURES) {
        await app?.close();
        return;
      }
      if (tooling && scratch.length > 0) {
        await cleanupBillingPersonaFixtures(tooling, {
          scope: "DATABASE",
          dryRun: false,
          personas: scratch,
        });
        await prisma.user.deleteMany({
          where: { email: { in: scratch.map((persona) => persona.email) } },
        });
      }
      await app?.close();
    }, STRIPE_TIMEOUT_MS);

    function scratchOf(base: BillingPersona): BillingPersona {
      const persona = {
        ...base,
        email: `billing-audit-${randomUUID()}@example.test`,
      };
      scratch.push(persona);
      return persona;
    }

    /** A persona's lifecycle on another catalog price: the plan and cadence follow the price. */
    function onPrice(
      base: BillingPersona,
      priceKey: BillingPriceKey,
    ): BillingPersona {
      const { plan, interval } = BILLING_CATALOG[priceKey];
      return {
        ...base,
        priceKey,
        subscribedPlan: plan,
        interval,
        expected: {
          ...base.expected,
          userPlan: base.expected.userPlan === "FREE" ? "FREE" : plan,
        },
      };
    }

    async function authUser(email: string): Promise<AuthUser> {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      return {
        id: user.id,
        email: user.email,
        role: user.role,
        plan: user.plan,
      };
    }

    /** What Stripe and FactorSage hold for one account, in one record. */
    async function observe(
      step: string,
      email: string,
      customerId: string,
    ): Promise<Observation> {
      const state = await stripe.loadCustomerBillingState(customerId);
      const catalog = app.get<BillingCatalog>(BILLING_CATALOG_TOKEN);
      const priceKey = (priceId: string | null | undefined) => {
        if (!priceId) return null;
        const resolved = catalog.resolvePriceId(priceId);
        return resolved
          ? `${resolved.plan}_${resolved.interval}`
          : `unknown:${priceId}`;
      };
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        include: { billingSubscription: true },
      });
      const customer = await tooling.fixtures.retrieveCustomer(customerId);
      const clock = customer?.testClockId
        ? await tooling.fixtures.retrieveTestClock(customer.testClockId)
        : null;
      return {
        step,
        clockTime: clock?.frozenTime.toISOString() ?? null,
        stripe: state.subscriptions.map((subscription) => ({
          status: subscription.status,
          price: priceKey(subscription.currentPriceId),
          periodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          scheduled: subscription.scheduleId !== null,
          nextPhase: state.scheduledPhases[subscription.id]
            ? {
                price: priceKey(
                  state.scheduledPhases[subscription.id]!.priceId,
                ),
                startsAt:
                  state.scheduledPhases[
                    subscription.id
                  ]!.startsAt?.toISOString() ?? null,
              }
            : null,
          pendingUpdate: subscription.hasPendingUpdate,
        })),
        factorsage: {
          plan: user.plan,
          mirror: user.billingSubscription
            ? {
                status: user.billingSubscription.status,
                price: priceKey(user.billingSubscription.stripePriceId),
                pendingPrice: priceKey(user.billingSubscription.pendingPriceId),
                pendingEffectiveAt:
                  user.billingSubscription.pendingEffectiveAt?.toISOString() ??
                  null,
              }
            : null,
        },
      };
    }

    async function reconcile(email: string): Promise<void> {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      await reconciliation.reconcileUser({
        userId: user.id,
        trigger: "MANUAL",
      });
    }

    /** Advances a customer's Test Clock to `to` and waits until Stripe has finished applying it. */
    async function advanceClock(customerId: string, to: Date): Promise<void> {
      const customer = await tooling.fixtures.retrieveCustomer(customerId);
      const clockId = customer?.testClockId;
      if (!clockId) throw new Error("The scratch customer has no Test Clock");
      await tooling.fixtures.advanceTestClock({
        clockId,
        frozenTime: to,
        idempotencyKey: `audit-advance:${clockId}:${to.getTime()}`,
      });
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        const clock = await tooling.fixtures.retrieveTestClock(clockId);
        if (clock?.status === "ready") return;
        if (Date.now() > deadline)
          throw new Error(`Test Clock still ${clock?.status}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    }

    /**
     * Advances a customer's Test Clock to `to` in steps of under two months. Stripe refuses to move a
     * clock more than two intervals of its shortest recurring price at once, and a scheduled monthly
     * phase makes that a month even while the subscription itself is still yearly.
     */
    async function advanceClockInSteps(
      customerId: string,
      to: Date,
    ): Promise<void> {
      const customer = await tooling.fixtures.retrieveCustomer(customerId);
      const clockId = customer?.testClockId;
      if (!clockId) throw new Error("The scratch customer has no Test Clock");
      const clock = await tooling.fixtures.retrieveTestClock(clockId);
      let at = clock!.frozenTime.getTime();
      while (at < to.getTime()) {
        at = Math.min(to.getTime(), at + 55 * DAY_MS);
        await advanceClock(customerId, new Date(at));
      }
    }

    /** Evidence stays under the git-ignored `.debug/`; Stripe object ids are kept out of it unless asked. */
    function record(
      name: string,
      observations: readonly unknown[],
      customerId?: string,
    ): void {
      writeFileSync(
        join(EVIDENCE_DIR, `${name}.json`),
        `${JSON.stringify(observations, null, 2)}\n`,
      );
      if (KEEP_FIXTURES && customerId) {
        writeFileSync(
          join(EVIDENCE_DIR, `${name}.customer`),
          `${customerId}\n`,
        );
      }
    }

    it("is pointed at a sandbox", () => {
      expect(stripe.testMode).toBe(true);
    });

    /**
     * BILL-01: PRO_MONTHLY → STARTER_MONTHLY (scheduled for the period end) → PRO_PLUS_MONTHLY the
     * same day (a tier upgrade, so immediate and invoiced). The user has paid the Pro+ proration; at
     * the period end the downgrade was scheduled for they must still be on PRO_PLUS_MONTHLY, and
     * nothing may still be scheduled.
     *
     * Observed on 2026-10-16 before the fix, with the then-sold PRO_YEARLY as the upgrade: the
     * upgrade succeeded and was invoiced, the schedule stayed attached with its STARTER_MONTHLY
     * phase, and at the old monthly boundary Stripe moved the subscription to STARTER_MONTHLY —
     * FactorSage followed to STARTER. The upgrade now releases the schedule before it updates the
     * price.
     */
    it(
      "BILL-01: an immediate upgrade made while a downgrade is scheduled survives the old period end",
      async () => {
        const persona = scratchOf(BILLING_PERSONAS.BILLING_PRO_ACTIVE);
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const observations: unknown[] = [];
        observations.push(
          await observe("seeded PRO_MONTHLY", persona.email, seeded.customerId),
        );

        const downgrade = await billing.changePlan({
          user: await authUser(persona.email),
          priceKey: "STARTER_MONTHLY",
          requestId: randomUUID(),
        });
        observations.push({
          step: "changePlan STARTER_MONTHLY response",
          response: downgrade,
        });
        observations.push(
          await observe(
            "after scheduling the downgrade",
            persona.email,
            seeded.customerId,
          ),
        );

        let upgradeError: string | null = null;
        try {
          const upgrade = await billing.changePlan({
            user: await authUser(persona.email),
            priceKey: "PRO_PLUS_MONTHLY",
            requestId: randomUUID(),
          });
          observations.push({
            step: "changePlan PRO_PLUS_MONTHLY response",
            response: upgrade,
          });
        } catch (error: unknown) {
          upgradeError =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          observations.push({
            step: "changePlan PRO_PLUS_MONTHLY threw",
            error: upgradeError,
          });
        }
        const afterUpgrade = await observe(
          "after the immediate upgrade",
          persona.email,
          seeded.customerId,
        );
        observations.push(afterUpgrade);

        const live = await stripe.loadCustomerBillingState(seeded.customerId);
        const subscription = live.subscriptions.find(
          (entry) => entry.status === "active",
        );
        const boundary = new Date(
          (
            subscription?.currentPeriodEnd ??
            new Date(Date.now() + 32 * 24 * HOUR_MS)
          ).getTime(),
        );
        // The downgrade's phase began at the monthly period end that was current when it was
        // scheduled; take the later of that and the subscription's current period end, plus two hours.
        const scheduledBoundary = (
          afterUpgrade.factorsage as {
            mirror: { pendingEffectiveAt: string | null } | null;
          }
        ).mirror?.pendingEffectiveAt;
        const monthlyEnd = (
          observations[1] as { response?: { effectiveAt?: string } }
        )?.response?.effectiveAt;
        const target = new Date(
          Math.max(
            Date.parse(
              scheduledBoundary ?? monthlyEnd ?? boundary.toISOString(),
            ),
            Date.parse(
              (observations[0] as { stripe: { periodEnd: string | null }[] })
                .stripe[0]?.periodEnd ?? boundary.toISOString(),
            ),
          ) +
            2 * HOUR_MS,
        );
        await advanceClock(seeded.customerId, target);
        await reconcile(persona.email);
        const afterBoundary = await observe(
          "after the period end the downgrade was scheduled for",
          persona.email,
          seeded.customerId,
        );
        observations.push(afterBoundary);
        record(
          "bill-01-upgrade-while-downgrade-scheduled",
          observations,
          seeded.customerId,
        );

        expect(upgradeError).toBeNull();
        expect(afterBoundary.stripe).toEqual([
          expect.objectContaining({
            status: "active",
            price: "PRO_PLUS_MONTH",
            scheduled: false,
          }),
        ]);
        expect(afterBoundary.factorsage).toEqual(
          expect.objectContaining({ plan: "PRO_PLUS" }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * BILL-02: two Checkout requests for one account before either is paid. Paying needs a browser,
     * so this proves what decides payability: after the second request, exactly one of the
     * customer's sessions is still open at Stripe — the first was expired when the second was made.
     */
    it(
      "BILL-02: a second Checkout leaves exactly one payable session",
      async () => {
        // The canceled persona: a customer on its own Test Clock whose subscription has ended, so
        // Checkout is allowed and everything it creates goes when the clock is deleted.
        const persona = scratchOf(BILLING_PERSONAS.BILLING_CANCELED);
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const user = await authUser(persona.email);

        const first = await billing.createCheckoutSession({
          user,
          priceKey: "PRO_MONTHLY",
          requestId: randomUUID(),
        });
        const second = await billing.createCheckoutSession({
          user,
          priceKey: "PRO_MONTHLY",
          requestId: randomUUID(),
        });
        expect(first.checkoutUrl).not.toBe(second.checkoutUrl);

        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
            .stripeCustomerId,
        ).toBe(seeded.customerId);
        // Only the second session was still open; expiring it now leaves the account with none.
        const sweep = await stripe.expireOpenCheckoutSessions(
          seeded.customerId,
        );
        record("bill-02-two-checkouts", [
          { step: "two Checkout requests, then a sweep", sweep },
        ]);
        expect(sweep).toEqual({ expired: 1, completed: 0 });
        // Nothing live was created: the canceled subscription is still the only one.
        expect(
          (
            await stripe.loadCustomerBillingState(seeded.customerId)
          ).subscriptions.map((subscription) => subscription.status),
        ).toEqual(["canceled"]);
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * A renewal that cannot be charged goes `past_due` and keeps the earned plan during Stripe's
     * retries; a working card then lets the next retry pay, and the account is active again.
     */
    it(
      "recovers a past-due renewal once a working card is on file",
      async () => {
        const persona = scratchOf(BILLING_PERSONAS.BILLING_STARTER_PAST_DUE);
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const observations: unknown[] = [];
        observations.push(
          await observe("seeded past_due", persona.email, seeded.customerId),
        );

        const card = await tooling.fixtures.attachTestPaymentMethod({
          customerId: seeded.customerId,
          behavior: "SUCCEEDS",
          metadata: { purpose: "audit-recovery" },
          idempotencyKey: `audit-recovery-card:${seeded.customerId}`,
        });
        await tooling.fixtures.setSubscriptionPaymentMethod({
          subscriptionId: seeded.subscription.id,
          paymentMethodId: card.id,
        });
        observations.push({
          step: "working card set as the subscription's default",
        });

        const customer = await tooling.fixtures.retrieveCustomer(
          seeded.customerId,
        );
        const clock = await tooling.fixtures.retrieveTestClock(
          customer!.testClockId!,
        );
        let recovered = false;
        // Stripe retries a failed renewal on its own schedule; walk the clock a few days at a time.
        for (let day = 1; day <= 4 && !recovered; day += 1) {
          await advanceClock(
            seeded.customerId,
            new Date(clock!.frozenTime.getTime() + day * 3 * 24 * HOUR_MS),
          );
          await reconcile(persona.email);
          const step = await observe(
            `clock +${day * 3} days`,
            persona.email,
            seeded.customerId,
          );
          observations.push(step);
          recovered = (step.stripe as { status: string }[]).some(
            (subscription) => subscription.status === "active",
          );
        }
        record("past-due-recovery", observations);

        expect(recovered).toBe(true);
        const last = observations[observations.length - 1] as Observation;
        expect(last.factorsage).toEqual(
          expect.objectContaining({
            plan: "STARTER",
            mirror: expect.objectContaining({ status: "ACTIVE" }),
          }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );

    /** A paid renewal moves the period on and keeps the plan. */
    it(
      "renews an active subscription at its period end",
      async () => {
        const persona = scratchOf(BILLING_PERSONAS.BILLING_PRO_ACTIVE);
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const before = await observe(
          "seeded PRO_MONTHLY",
          persona.email,
          seeded.customerId,
        );
        const periodEnd = Date.parse(
          (before.stripe as { periodEnd: string }[])[0]!.periodEnd,
        );
        await advanceClock(
          seeded.customerId,
          new Date(periodEnd + 2 * HOUR_MS),
        );
        await reconcile(persona.email);
        const after = await observe(
          "after the period end",
          persona.email,
          seeded.customerId,
        );
        record("renewal", [before, after]);

        expect(after.stripe).toEqual([
          expect.objectContaining({ status: "active", price: "PRO_MONTH" }),
        ]);
        expect(
          Date.parse((after.stripe as { periodEnd: string }[])[0]!.periodEnd),
        ).toBeGreaterThan(periodEnd);
        expect(after.factorsage).toEqual(
          expect.objectContaining({ plan: "PRO" }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * A yearly price is charged in full when the subscription starts: one paid invoice for the
     * catalog's annual amount, whose one line covers a whole year. Nothing is billed monthly.
     */
    it.each(YEARLY_KEYS)(
      "charges the full year of %s upfront",
      async (priceKey) => {
        const persona = scratchOf(
          onPrice(BILLING_PERSONAS.BILLING_PRO_ACTIVE, priceKey),
        );
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const invoices = await tooling.fixtures.listSubscriptionInvoices(
          seeded.subscription.id,
        );
        const seededState = await observe(
          `seeded ${priceKey}`,
          persona.email,
          seeded.customerId,
        );
        record(`yearly-upfront-${priceKey.toLowerCase()}`, [
          seededState,
          {
            step: "invoices",
            invoices: invoices.map((invoice) => ({
              status: invoice.status,
              billingReason: invoice.billingReason,
              currency: invoice.currency,
              amountDue: invoice.amountDue,
              amountPaid: invoice.amountPaid,
              lines: invoice.lines.map((line) => ({
                amount: line.amount,
                days:
                  (line.periodEnd.getTime() - line.periodStart.getTime()) /
                  DAY_MS,
              })),
            })),
          },
        ]);

        const amount = BILLING_CATALOG[priceKey].amountMinorUnits;
        expect(invoices).toHaveLength(1);
        const [invoice] = invoices;
        expect(invoice).toEqual(
          expect.objectContaining({
            status: "paid",
            billingReason: "subscription_create",
            currency: "usd",
            amountDue: amount,
            amountPaid: amount,
          }),
        );
        expect(invoice!.lines).toHaveLength(1);
        const [line] = invoice!.lines;
        expect(line!.priceId).toBe(
          tooling.catalog.resolveKey(priceKey).priceId,
        );
        expect(line!.amount).toBe(amount);
        const days =
          (line!.periodEnd.getTime() - line!.periodStart.getTime()) / DAY_MS;
        expect(days).toBeGreaterThanOrEqual(365);
        expect(days).toBeLessThanOrEqual(366);
        expect(seededState.factorsage).toEqual(
          expect.objectContaining({
            plan: BILLING_CATALOG[priceKey].plan,
            mirror: expect.objectContaining({
              price: `${BILLING_CATALOG[priceKey].plan}_YEAR`,
            }),
          }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * Monthly → yearly within one plan lengthens the cadence: applied at once, and Stripe prorates
     * it (`always_invoice`) — the unused part of the month is credited against the year, the year
     * starts now and is charged now.
     */
    it(
      "moves PRO_MONTHLY to PRO_YEARLY at once and invoices the prorated year",
      async () => {
        const persona = scratchOf(BILLING_PERSONAS.BILLING_PRO_ACTIVE);
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const observations: unknown[] = [
          await observe("seeded PRO_MONTHLY", persona.email, seeded.customerId),
        ];

        const change = await billing.changePlan({
          user: await authUser(persona.email),
          priceKey: "PRO_YEARLY",
          requestId: randomUUID(),
        });
        observations.push({ step: "changePlan PRO_YEARLY response", change });
        await reconcile(persona.email);
        const after = await observe(
          "after the cadence change",
          persona.email,
          seeded.customerId,
        );
        observations.push(after);
        const invoices = await tooling.fixtures.listSubscriptionInvoices(
          seeded.subscription.id,
        );
        const update = invoices.find(
          (invoice) => invoice.billingReason === "subscription_update",
        );
        observations.push({
          step: "the proration invoice",
          status: update?.status ?? null,
          amountPaid: update?.amountPaid ?? null,
          lines: update?.lines.map((line) => line.amount) ?? null,
        });
        record("cadence-monthly-to-yearly", observations, seeded.customerId);

        expect(change).toEqual(
          expect.objectContaining({
            effect: "IMMEDIATE",
            kind: "CADENCE_LENGTHENED",
            effectiveAt: null,
            plan: "PRO",
          }),
        );
        expect(after.stripe).toEqual([
          expect.objectContaining({
            status: "active",
            price: "PRO_YEAR",
            scheduled: false,
            pendingUpdate: false,
          }),
        ]);
        expect(after.factorsage).toEqual({
          plan: "PRO",
          mirror: expect.objectContaining({
            status: "ACTIVE",
            price: "PRO_YEAR",
            pendingPrice: null,
          }),
        });
        // The new period is a year from the change.
        const periodEnd = Date.parse(
          (after.stripe as { periodEnd: string }[])[0]!.periodEnd,
        );
        const clockTime = Date.parse(after.clockTime as string);
        expect((periodEnd - clockTime) / DAY_MS).toBeGreaterThan(364);
        // Paid now: the year, less the unused month.
        expect(update).toEqual(expect.objectContaining({ status: "paid" }));
        expect(update!.amountPaid).toBeGreaterThan(0);
        expect(update!.amountPaid).toBeLessThan(
          BILLING_CATALOG.PRO_YEARLY.amountMinorUnits,
        );
        expect(update!.lines.some((line) => line.amount < 0)).toBe(true);
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * Yearly → monthly within one plan shortens the cadence: the paid year is kept, and the monthly
     * price starts at its end. Stripe holds it as a Subscription Schedule phase; after the year,
     * the first monthly invoice is the monthly amount and the spent schedule is released.
     */
    it(
      "schedules PRO_YEARLY to PRO_MONTHLY for the end of the paid year",
      async () => {
        const persona = scratchOf(
          onPrice(BILLING_PERSONAS.BILLING_PRO_ACTIVE, "PRO_YEARLY"),
        );
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const seededState = await observe(
          "seeded PRO_YEARLY",
          persona.email,
          seeded.customerId,
        );
        const observations: unknown[] = [seededState];
        const yearEnd = Date.parse(
          (seededState.stripe as { periodEnd: string }[])[0]!.periodEnd,
        );

        const change = await billing.changePlan({
          user: await authUser(persona.email),
          priceKey: "PRO_MONTHLY",
          requestId: randomUUID(),
        });
        observations.push({ step: "changePlan PRO_MONTHLY response", change });
        const scheduled = await observe(
          "after scheduling the monthly cadence",
          persona.email,
          seeded.customerId,
        );
        observations.push(scheduled);

        await advanceClockInSteps(
          seeded.customerId,
          new Date(yearEnd + 2 * HOUR_MS),
        );
        await reconcile(persona.email);
        const after = await observe(
          "after the paid year",
          persona.email,
          seeded.customerId,
        );
        observations.push(after);
        const renewal = (
          await tooling.fixtures.listSubscriptionInvoices(
            seeded.subscription.id,
          )
        ).find((invoice) => invoice.created.getTime() >= yearEnd);
        observations.push({
          step: "the first invoice after the year",
          status: renewal?.status ?? null,
          amountPaid: renewal?.amountPaid ?? null,
        });
        record("cadence-yearly-to-monthly", observations, seeded.customerId);

        expect(change).toEqual({
          effect: "SCHEDULED",
          kind: "CADENCE_SHORTENED",
          effectiveAt: new Date(yearEnd).toISOString(),
          plan: "PRO",
        });
        expect(scheduled.stripe).toEqual([
          expect.objectContaining({
            status: "active",
            price: "PRO_YEAR",
            scheduled: true,
            nextPhase: {
              price: "PRO_MONTH",
              startsAt: new Date(yearEnd).toISOString(),
            },
          }),
        ]);
        expect(scheduled.factorsage).toEqual({
          plan: "PRO",
          mirror: expect.objectContaining({
            price: "PRO_YEAR",
            pendingPrice: "PRO_MONTH",
            pendingEffectiveAt: new Date(yearEnd).toISOString(),
          }),
        });

        expect(after.stripe).toEqual([
          expect.objectContaining({
            status: "active",
            price: "PRO_MONTH",
            scheduled: false,
          }),
        ]);
        expect(after.factorsage).toEqual({
          plan: "PRO",
          mirror: expect.objectContaining({
            status: "ACTIVE",
            price: "PRO_MONTH",
            pendingPrice: null,
          }),
        });
        expect(renewal).toEqual(
          expect.objectContaining({
            status: "paid",
            amountPaid: BILLING_CATALOG.PRO_MONTHLY.amountMinorUnits,
          }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );

    /** A yearly renewal that cannot be charged goes `past_due` and keeps the plan, as a monthly one does. */
    it(
      "keeps the plan of a STARTER_YEARLY subscriber whose renewal failed",
      async () => {
        const persona = scratchOf(
          onPrice(BILLING_PERSONAS.BILLING_STARTER_PAST_DUE, "STARTER_YEARLY"),
        );
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        const state = await observe(
          "seeded past_due on STARTER_YEARLY",
          persona.email,
          seeded.customerId,
        );
        record("yearly-renewal-failure", [state]);

        expect(seeded.problems).toEqual([]);
        expect(state.stripe).toEqual([
          expect.objectContaining({
            status: "past_due",
            price: "STARTER_YEAR",
          }),
        ]);
        expect(state.factorsage).toEqual({
          plan: "STARTER",
          mirror: expect.objectContaining({
            status: "PAST_DUE",
            price: "STARTER_YEAR",
          }),
        });
      },
      STRIPE_TIMEOUT_MS,
    );

    /**
     * A subscriber on a retired V1 price (STRIPE_LEGACY_PRICES) keeps it: the same plan and cadence
     * is "already on that plan", nothing at Stripe moves, and the status says the price is a kept
     * one. An upgrade is an ordinary upgrade onto today's catalog. Built by moving a fresh
     * subscription onto the retired price at Stripe directly — the product itself can never sell
     * one.
     */
    it(
      "keeps a grandfathered V1 subscriber on the retired price until they change plan",
      async (context) => {
        const legacy =
          config.legacyPrices?.find(
            (entry) => entry.plan === "PRO" && entry.interval === "YEAR",
          ) ?? config.legacyPrices?.[0];
        if (!legacy) {
          // No STRIPE_LEGACY_PRICES configured: no retired price to grandfather.
          context.skip();
          return;
        }
        const currentKey = findBillingPriceKey(legacy.plan, legacy.interval);
        const upgradeKey = findBillingPriceKey("PRO_PLUS", legacy.interval);
        if (!currentKey || !upgradeKey) {
          throw new Error(
            `No catalog price for ${legacy.plan}/${legacy.interval}`,
          );
        }
        const persona = scratchOf(
          onPrice(BILLING_PERSONAS.BILLING_PRO_ACTIVE, currentKey),
        );
        const seeded = await seedBillingPersona(tooling, persona, {
          password: null,
        });
        expect(seeded.problems).toEqual([]);
        const live = await stripe.loadCustomerBillingState(seeded.customerId);
        await stripe.updateSubscriptionPriceImmediately({
          subscriptionId: seeded.subscription.id,
          itemId: live.subscriptions[0]!.itemId!,
          priceId: legacy.priceId,
          idempotencyKey: `audit-legacy:${seeded.subscription.id}`,
        });
        await reconcile(persona.email);
        const user = await authUser(persona.email);
        const grandfathered = await billing.readStatus(user);
        const observations: unknown[] = [
          {
            step: "moved onto the retired price at Stripe",
            plan: grandfathered.plan,
            legacyPrice: grandfathered.subscription?.legacyPrice ?? null,
            onRetiredPrice:
              grandfathered.subscription !== null &&
              (
                await prisma.billingSubscription.findUniqueOrThrow({
                  where: { userId: user.id },
                })
              ).stripePriceId === legacy.priceId,
          },
        ];

        let sameError: string | null = null;
        try {
          await billing.changePlan({
            user,
            priceKey: currentKey,
            requestId: randomUUID(),
          });
        } catch (error: unknown) {
          sameError =
            error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : String(error);
        }
        const afterRefusal = await stripe.loadCustomerBillingState(
          seeded.customerId,
        );
        observations.push({
          step: `changePlan ${currentKey} (same plan and cadence)`,
          error: sameError,
          stillOnRetiredPrice:
            afterRefusal.subscriptions[0]?.currentPriceId === legacy.priceId,
        });

        const upgrade = await billing.changePlan({
          user: await authUser(persona.email),
          priceKey: upgradeKey,
          requestId: randomUUID(),
        });
        await reconcile(persona.email);
        const upgraded = await billing.readStatus(
          await authUser(persona.email),
        );
        const afterUpgrade = await stripe.loadCustomerBillingState(
          seeded.customerId,
        );
        observations.push({
          step: `changePlan ${upgradeKey}`,
          upgrade,
          plan: upgraded.plan,
          legacyPrice: upgraded.subscription?.legacyPrice ?? null,
          onTodaysPrice:
            afterUpgrade.subscriptions[0]?.currentPriceId ===
            tooling.catalog.resolveKey(upgradeKey).priceId,
        });
        record("legacy-grandfathered", observations, seeded.customerId);

        expect(observations[0]).toEqual(
          expect.objectContaining({
            plan: legacy.plan,
            legacyPrice: true,
            onRetiredPrice: true,
          }),
        );
        expect(observations[1]).toEqual(
          expect.objectContaining({
            error: "BILLING_CHANGE_NOT_ALLOWED",
            stillOnRetiredPrice: true,
          }),
        );
        expect(upgrade).toEqual(
          expect.objectContaining({
            effect: "IMMEDIATE",
            kind: "TIER_UPGRADE",
          }),
        );
        expect(observations[2]).toEqual(
          expect.objectContaining({
            plan: "PRO_PLUS",
            legacyPrice: false,
            onTodaysPrice: true,
          }),
        );
      },
      STRIPE_TIMEOUT_MS,
    );
  },
);
