import { randomBytes, randomUUID } from "node:crypto";
import { getStripeBillingConfig } from "@intrinsic/config";
import type {
  BillingStatusResponse,
  EntitlementsResponse,
} from "@intrinsic/contracts";
import { createLogger } from "@intrinsic/observability";
import {
  BILLING_PERSONAS,
  BILLING_PERSONA_LIST,
  useTestDatabase,
  type BillingPersona,
} from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BillingCatalog } from "../billing/billing-catalog";
import { BillingReconciliationService } from "../billing/billing-reconciliation.service";
import { BillingModule } from "../billing/billing.module";
import {
  BILLING_CATALOG_TOKEN,
  STRIPE_GATEWAY,
} from "../billing/billing.tokens";
import { verifyStripeCatalog } from "../billing/catalog-verification";
import {
  hasScheduledCancellation,
  type StripeGateway,
} from "../billing/stripe-gateway";
import { StripeTestModeFixtureGateway } from "../billing/stripe.gateway";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import {
  assertBillingPersonaStripeConfig,
  resolveBillingPersonaDatabase,
  resolveBillingPersonaPassword,
} from "./billing-persona-environment";
import {
  BILLING_PERSONA_METADATA_KEYS,
  billingPersonaFixtureMetadata,
  parseBillingPersonaClockName,
} from "./billing-persona-fixtures";
import {
  DEFAULT_BILLING_PERSONA_TIMING,
  cleanupBillingPersonaFixtures,
  inspectBillingPersona,
  observeBillingPersonaFixtures,
  seedBillingPersona,
  type BillingPersonaSeedResult,
  type BillingPersonaTooling,
} from "./billing-persona-tooling";

/**
 * The billing QA personas against **real Stripe test mode**. Opt-in, and excluded from `pnpm test`.
 *
 * ```bash
 * STRIPE_BILLING_PERSONAS=true pnpm test:billing:personas
 * # in a Claude cloud session:
 * STRIPE_BILLING_PERSONAS=true scripts/cloud/with-stripe.sh pnpm test:billing:personas
 * ```
 *
 * `billing-persona-tooling.integration.test.ts` proves the tooling against a fake Stripe inside the
 * normal gate. This is the layer that fake cannot stand in for: that a real subscription on a real
 * Test Clock really does go `past_due` when its renewal fails, really is cancelled when its paid
 * period ends, that a period-end cancellation really comes back in the representation the gateway
 * was written for — and that the application's real reconciliation, HTTP surface and entitlement
 * resolver make of each state exactly what the decision document says.
 *
 * Nothing about the application is faked: this compiles the real billing module with the real
 * `StripeApiGateway`, on the dedicated test database, and reads every result back over HTTP as a
 * signed-in persona.
 *
 * Three guards, all deliberate, the same three the sandbox smoke suite has:
 *
 * 1. it skips entirely unless `STRIPE_BILLING_PERSONAS=true`, so it is inert even when reached by
 *    path;
 * 2. `pnpm test` also excludes it by path;
 * 3. it refuses anything but a test-mode key, production, and a database that is not the local
 *    test database, before a Stripe or database client exists.
 *
 * It leaves the five personas **seeded** — in the Stripe sandbox and in the test database — so the
 * browser suite (`pnpm test:e2e:billing:personas`) can read them afterwards. Remove them with
 * `pnpm qa:billing:cleanup -- --database test`. A sixth, throwaway fixture is created and removed
 * by the cleanup case itself.
 */

const ENABLED = process.env.STRIPE_BILLING_PERSONAS?.trim() === "true";

if (ENABLED) {
  // Before PrismaService constructs its client during Nest module compilation.
  useTestDatabase();
}

/** Building a lifecycle means waiting on Stripe to advance a Test Clock. */
const STRIPE_TIMEOUT_MS = 10 * 60_000;

describe.skipIf(!ENABLED)(
  "billing QA personas against the Stripe sandbox",
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let stripe: StripeGateway;
    let catalog: BillingCatalog;
    let tooling: BillingPersonaTooling;
    let password: string;

    beforeAll(async () => {
      // Refusals first, before anything can act: test mode only, never production, and only the
      // local test database.
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
      // Bound to loopback explicitly, as `registration-enumeration.integration.test.ts` is. Left
      // unlistened, supertest binds a wildcard ephemeral port per request, and on macOS that port
      // can coincide with one another process holds on 127.0.0.1 — the request then reaches that
      // process instead, and a real route answers 404.
      await app.listen(0, "127.0.0.1");

      prisma = app.get(PrismaService);
      stripe = app.get<StripeGateway>(STRIPE_GATEWAY);
      catalog = app.get<BillingCatalog>(BILLING_CATALOG_TOKEN);
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
        catalog,
        // The application's own instance, resolved from its module graph.
        reconciliation: app.get(BillingReconciliationService),
        hashPassword: (value) => passwords.hash(value),
        report: () => undefined,
        timing: DEFAULT_BILLING_PERSONA_TIMING,
        createdBy: "pnpm test:billing:personas",
      };

      // The check `pnpm billing:verify-catalog` makes, as a gate: no fixture is built on a catalog
      // it would reject, because a mis-mapped price would be a persona on the wrong plan.
      const { findings } = await verifyStripeCatalog({ stripe, catalog });
      if (findings.length > 0) {
        throw new Error(
          "The configured Stripe catalog is not the V1 catalog; no fixture was created. " +
            findings
              .map((finding) => `${finding.key}: ${finding.problem}`)
              .join("; "),
        );
      }

      // The configured shared password when there is one, so a persona seeded here can be signed in
      // to afterwards; otherwise one nobody else knows, for this run's own sign-ins.
      password =
        resolveBillingPersonaPassword() ??
        randomBytes(18).toString("base64url");
    }, STRIPE_TIMEOUT_MS);

    afterAll(async () => {
      await app?.close();
    });

    async function signedInAs(persona: BillingPersona) {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post("/auth/login")
        .send({ email: persona.email, password })
        .expect(200);
      return agent;
    }

    it("is pointed at a sandbox", () => {
      expect(stripe.testMode).toBe(true);
    });

    describe.each(
      BILLING_PERSONA_LIST.map((persona) => [persona.name, persona] as const),
    )("%s", (_name, persona) => {
      const { expected } = persona;
      let seeded: BillingPersonaSeedResult;

      it(
        "is built in Stripe and reconciled by the application",
        async () => {
          seeded = await seedBillingPersona(tooling, persona, { password });
          expect(seeded.problems).toEqual([]);
        },
        STRIPE_TIMEOUT_MS,
      );

      it("holds its declared state in Stripe, as the product's gateway reads it", async () => {
        // The exact read reconciliation makes.
        const state = await stripe.loadCustomerBillingState(seeded.customerId);
        expect(state.subscriptions).toHaveLength(1);
        const subscription = state.subscriptions[0];

        expect(subscription?.status).toBe(expected.stripeStatus);
        expect(subscription?.currentPriceId).toBe(
          catalog.resolveKey(persona.priceKey).priceId,
        );
        expect(subscription?.hasPendingUpdate).toBe(false);
        expect(subscription?.scheduleId).toBeNull();
        if (expected.holdsPaidSlot) {
          expect(subscription?.cancelAtPeriodEnd).toBe(
            expected.cancellationScheduled,
          );
        }
      });

      it("is a tagged, test-mode fixture on its own Test Clock", async () => {
        const [raw] = await tooling.fixtures.listSubscriptions(
          seeded.customerId,
        );
        const customer = await tooling.fixtures.retrieveCustomer(
          seeded.customerId,
        );
        // Who owns it — not which command created it, which is informational and differs when the
        // fixture was first built by `pnpm qa:billing:seed`.
        const ownership = Object.fromEntries(
          Object.entries(
            billingPersonaFixtureMetadata(
              { persona: persona.name, ownerUserId: seeded.userId },
              tooling.createdBy,
            ),
          ).filter(([key]) => key !== BILLING_PERSONA_METADATA_KEYS.createdBy),
        );

        expect(raw?.livemode).toBe(false);
        expect(customer?.livemode).toBe(false);
        expect(raw?.metadata).toMatchObject(ownership);
        expect(customer?.metadata).toMatchObject(ownership);
        expect(customer?.email).toBe(persona.email);

        const clock = await tooling.fixtures.retrieveTestClock(
          customer?.testClockId ?? "",
        );
        expect(clock?.livemode).toBe(false);
        expect(clock?.status).toBe("ready");
        expect(parseBillingPersonaClockName(clock?.name ?? null)).toEqual({
          persona: persona.name,
          ownerUserId: seeded.userId,
        });
      });

      if (persona.lifecycle === "CANCELING") {
        it("carries the cancellation in the representation the pinned API version returns", async () => {
          const [raw] = await tooling.fixtures.listSubscriptions(
            seeded.customerId,
          );
          // Whichever of the two raw fields Stripe used, a cancellation is scheduled…
          expect(raw && hasScheduledCancellation(raw)).toBe(true);
          // …and what `ai/architecture/billing.md` records for this API version is the newer one:
          // `cancel_at` at the period end, with the raw flag false.
          expect(raw?.cancelAt).toEqual(raw?.currentPeriodEnd);
          expect(raw?.cancelAtPeriodEnd).toBe(false);
          expect(raw?.status).toBe("active");
        });
      }

      it("is mirrored and planned exactly as the decision document says", async () => {
        const account = await prisma.user.findUniqueOrThrow({
          where: { email: persona.email },
          include: { billingSubscription: true },
        });
        const mirror = account.billingSubscription;

        expect(account.plan).toBe(expected.userPlan);
        expect(account.role).toBe("USER");
        expect(account.stripeCustomerId).toBe(seeded.customerId);
        expect(mirror?.status).toBe(expected.mirrorStatus);
        expect(mirror?.planReason).toBe(expected.planReason);
        expect(mirror?.plan).toBe(persona.subscribedPlan);
        expect(mirror?.billingInterval).toBe(persona.interval);
        expect(mirror?.stripePriceId).toBe(
          catalog.resolveKey(persona.priceKey).priceId,
        );
        expect(mirror?.stripeSubscriptionId).toBe(seeded.subscription.id);
        expect(mirror?.currentPeriodEnd).not.toBeNull();
        if (expected.holdsPaidSlot) {
          expect(mirror?.cancelAtPeriodEnd).toBe(
            expected.cancellationScheduled,
          );
        }
        if (expected.cancellationScheduled) {
          expect(mirror?.cancelAt).toEqual(mirror?.currentPeriodEnd);
        }
        if (expected.mirrorStatus === "CANCELED") {
          expect(mirror?.canceledAt).not.toBeNull();
        }
      });

      it("is reported by GET /billing/status without a Stripe identifier", async () => {
        const agent = await signedInAs(persona);
        const response = await agent.get("/billing/status").expect(200);
        const status = response.body as BillingStatusResponse;

        expect(status.plan).toBe(expected.userPlan);
        expect(status.billingEnabled).toBe(true);
        expect(status.subscription?.status).toBe(expected.mirrorStatus);
        expect(status.subscription?.plan).toBe(persona.subscribedPlan);
        expect(status.subscription?.interval).toBe(persona.interval);
        expect(status.canStartCheckout).toBe(!expected.holdsPaidSlot);
        expect(status.canChangePlan).toBe(expected.holdsPaidSlot);
        expect(status.canOpenPortal).toBe(true);
        if (expected.holdsPaidSlot) {
          expect(status.subscription?.cancelAtPeriodEnd).toBe(
            expected.cancellationScheduled,
          );
        }
        if (expected.cancellationScheduled) {
          expect(status.subscription?.cancelAt).toBe(
            status.subscription?.currentPeriodEnd,
          );
        }
        expect(response.text).not.toMatch(
          /cus_|sub_|price_|clock_|sk_test|whsec_/,
        );
      });

      it("has exactly the entitlements of its reconciled plan", async () => {
        const agent = await signedInAs(persona);
        const response = await agent.get("/entitlements").expect(200);
        const body = response.body as EntitlementsResponse;

        expect(body.principal).toBe("AUTHENTICATED");
        expect(body.plan).toBe(expected.userPlan);
        expect(body.entitlements.tier).toBe(expected.userPlan);
      });

      it(
        "is left alone by a second run",
        async () => {
          const again = await seedBillingPersona(tooling, persona, {
            password,
          });

          expect(again.stripe).toBe("REUSED");
          expect(again.problems).toEqual([]);
          expect(again.customerId).toBe(seeded.customerId);
          expect(again.subscription.id).toBe(seeded.subscription.id);

          const status = await inspectBillingPersona(tooling, persona);
          expect(status.verdict).toBe("CONVERGED");
        },
        STRIPE_TIMEOUT_MS,
      );
    });

    it("refuses a plan change while the cancellation is scheduled", async () => {
      const agent = await signedInAs(BILLING_PERSONAS.BILLING_PRO_CANCELING);
      const response = await agent
        .post("/billing/change")
        .send({ priceKey: "STARTER_MONTHLY" })
        .expect(409);
      expect((response.body as { code?: string }).code).toBe(
        "BILLING_CHANGE_NOT_ALLOWED",
      );
    });

    describe("cleanup", () => {
      // The same lifecycle as a real persona, under an address and an owner of its own, so removing
      // it proves the cleanup without touching the five personas above.
      const scratch: BillingPersona = {
        ...BILLING_PERSONAS.BILLING_PRO_ACTIVE,
        email: `billing-scratch-${randomUUID()}@example.test`,
      };

      afterAll(async () => {
        await prisma?.user.deleteMany({ where: { email: scratch.email } });
      });

      it(
        "deletes exactly its own fixture and returns the account to FREE",
        async () => {
          const seeded = await seedBillingPersona(tooling, scratch, {
            password: null,
          });
          expect(seeded.problems).toEqual([]);
          const customer = await tooling.fixtures.retrieveCustomer(
            seeded.customerId,
          );
          const clockId = customer?.testClockId ?? "";
          const others = (await observeBillingPersonaFixtures(tooling.fixtures))
            .map((fixture) => fixture.clock.id)
            .filter((id) => id !== clockId)
            .sort();

          const preview = await cleanupBillingPersonaFixtures(tooling, {
            scope: "DATABASE",
            dryRun: true,
            personas: [scratch],
          });
          expect(preview.fixtures.map((fixture) => fixture.clockId)).toEqual([
            clockId,
          ]);
          expect(
            await tooling.fixtures.retrieveTestClock(clockId),
          ).not.toBeNull();

          const result = await cleanupBillingPersonaFixtures(tooling, {
            scope: "DATABASE",
            dryRun: false,
            personas: [scratch],
          });

          expect(result.refusals).toEqual([]);
          expect(result.fixtures.map((fixture) => fixture.clockId)).toEqual([
            clockId,
          ]);
          // Everybody else's fixtures were outside the scope and are still there.
          expect(result.outOfScope).toBe(others.length);
          expect(
            (await observeBillingPersonaFixtures(tooling.fixtures))
              .map((fixture) => fixture.clock.id)
              .sort(),
          ).toEqual(others);

          // In Stripe the clock is gone, and it took its customer with it.
          expect(await tooling.fixtures.retrieveTestClock(clockId)).toBeNull();
          expect(
            await tooling.fixtures.retrieveCustomer(seeded.customerId),
          ).toBeNull();
          // Its subscription is cancelled rather than erased: Stripe goes on listing it, as
          // `canceled`, under the deleted customer's id. That is why an account left pointing at
          // one — the `STALE_LINK` an expired Test Clock produces — reconciles to FREE instead of
          // failing.
          const afterwards = await stripe.loadCustomerBillingState(
            seeded.customerId,
          );
          expect(
            afterwards.subscriptions.map((subscription) => subscription.status),
          ).toEqual(["canceled"]);

          // In FactorSage the account survives as an ordinary FREE account, by reconciliation.
          const account = await prisma.user.findUniqueOrThrow({
            where: { email: scratch.email },
            include: { billingSubscription: true },
          });
          expect(account.plan).toBe("FREE");
          expect(account.stripeCustomerId).toBeNull();
          expect(account.billingSubscription).toBeNull();
        },
        STRIPE_TIMEOUT_MS,
      );

      it("leaves the shared catalog exactly as it found it", async () => {
        const { findings } = await verifyStripeCatalog({ stripe, catalog });
        expect(findings).toEqual([]);
      });
    });
  },
);
