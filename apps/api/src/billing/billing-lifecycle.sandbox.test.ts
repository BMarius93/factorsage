import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStripeBillingConfig } from "@intrinsic/config";
import type { AuthUser } from "@intrinsic/contracts";
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
    const scratch: BillingPersona[] = [];

    beforeAll(async () => {
      const config = assertBillingPersonaStripeConfig(getStripeBillingConfig());
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
     * BILL-01: PRO_MONTHLY → STARTER_MONTHLY (scheduled for the period end) → PRO_YEARLY the same day
     * (a lengthened cadence, so immediate and invoiced). The user has paid for a year of PRO; at the
     * old period end they must still be on PRO_YEARLY, and nothing may still be scheduled.
     *
     * Observed on 2026-10-16: the upgrade succeeds and is invoiced, the schedule stays attached with
     * its STARTER_MONTHLY phase, and at the old monthly boundary Stripe moves the subscription to
     * STARTER_MONTHLY — FactorSage follows to STARTER. Marked `it.fails` while the defect is open.
     */
    it.fails(
      "KNOWN DEFECT BILL-01: an immediate upgrade made while a downgrade is scheduled survives the old period end",
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
            priceKey: "PRO_YEARLY",
            requestId: randomUUID(),
          });
          observations.push({
            step: "changePlan PRO_YEARLY response",
            response: upgrade,
          });
        } catch (error: unknown) {
          upgradeError =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          observations.push({
            step: "changePlan PRO_YEARLY threw",
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
          "after the old monthly period end",
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
            price: "PRO_YEAR",
            scheduled: false,
          }),
        ]);
        expect(afterBoundary.factorsage).toEqual(
          expect.objectContaining({ plan: "PRO" }),
        );
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
  },
);
