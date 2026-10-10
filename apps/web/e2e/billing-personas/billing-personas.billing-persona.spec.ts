import { BILLING_PERSONA_LIST } from "@intrinsic/testing/billing-personas";
import { expect, test, type Page } from "../fixtures";
import { openBillingPage, readBillingStatus } from "../utils/billing";
import { apiBaseUrl, type EntitlementsPayload } from "../utils/entitlements";

/**
 * What FactorSage shows a customer in each real subscription state.
 *
 * The accounts here are the billing QA personas (`@intrinsic/testing/billing-personas`). Unlike the
 * persona specs next door in `e2e/billing/`, whose plans are seeded and which have no subscription
 * at all, each of these holds a subscription that exists in Stripe test mode — active, scheduled to
 * cancel, past due, or ended — mirrored and planned by the application's own reconciliation before
 * this run. Nothing here drives Stripe, a Test Clock, Checkout or Portal: the suite reads what the
 * product makes of state that already exists.
 *
 * It runs only through `pnpm test:e2e:billing:personas`, on the hermetic stack, so every request
 * the page makes stays on this machine; `watchStripe` additionally proves the browser itself never
 * reaches for Stripe to render any of it.
 *
 * Expectations are literals from the registry and the decision document. The registry declares
 * what each persona must be; the pages below are held to it.
 */

const PLAN_LABEL = { FREE: "Free", STARTER: "Starter", PRO: "Pro" } as const;
const INTERVAL_LABEL = { MONTH: "Monthly", YEAR: "Yearly" } as const;

/** Every request the page makes to a Stripe host. Always empty in a passing test. */
function watchStripe(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      /^https?:\/\/([a-z0-9-]+\.)*stripe\.(com|network)\//i.test(request.url())
    ) {
      requests.push(request.url());
    }
  });
  return requests;
}

for (const persona of BILLING_PERSONA_LIST) {
  const { expected } = persona;

  test.describe(persona.name, () => {
    test.use({ storageState: persona.storageState });

    test("reports the reconciled plan and the mirrored subscription", async ({
      page,
    }) => {
      const status = await readBillingStatus(page);

      expect(status.plan).toBe(expected.userPlan);
      expect(status.subscription).not.toBeNull();
      expect(status.subscription?.status).toBe(expected.mirrorStatus);
      expect(status.subscription?.plan).toBe(persona.subscribedPlan);
      expect(status.subscription?.interval).toBe(persona.interval);
      // A subscription that still holds the paid slot blocks a second Checkout; an ended one
      // releases it.
      expect(status.canStartCheckout).toBe(!expected.holdsPaidSlot);
      expect(status.canOpenPortal).toBe(true);
      if (expected.holdsPaidSlot) {
        expect(status.subscription?.cancelAtPeriodEnd).toBe(
          expected.cancellationScheduled,
        );
      }
      if (expected.cancellationScheduled) {
        expect(status.subscription?.cancelAt).not.toBeNull();
      }
      // The status contract carries no Stripe identifier, for a real subscription either.
      expect(JSON.stringify(status)).not.toMatch(/cus_|sub_|price_|clock_/);
    });

    test("is entitled to exactly its reconciled plan", async ({ page }) => {
      const response = await page.request.get(`${apiBaseUrl()}/entitlements`);
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as EntitlementsPayload;

      expect(body.principal).toBe("AUTHENTICATED");
      expect(body.plan).toBe(expected.userPlan);
      expect(body.entitlements.tier).toBe(expected.userPlan);
    });

    test("shows the subscription the way a customer in that state must see it", async ({
      page,
    }) => {
      const stripeRequests = watchStripe(page);
      await openBillingPage(page);

      await expect(page.getByTestId("billing-plan")).toHaveText(
        PLAN_LABEL[expected.userPlan],
      );
      await expect(
        page.getByTestId(`plan-card-${expected.userPlan}`),
      ).toHaveAttribute("data-current", "true");
      await expect(page.getByTestId("plan-current-badge")).toHaveCount(1);
      await expect(page.getByTestId("manage-billing")).toBeVisible();

      const subscription = page.getByTestId("billing-subscription");
      await expect(subscription).toBeVisible();

      if (expected.holdsPaidSlot) {
        await expect(page.getByTestId("billing-interval")).toHaveText(
          INTERVAL_LABEL[persona.interval],
        );
        await expect(page.getByTestId("billing-period-end")).not.toBeEmpty();
      }

      switch (persona.lifecycle) {
        case "ACTIVE":
          await expect(subscription).toContainText("Renews");
          await expect(
            page.getByTestId("billing-cancel-scheduled"),
          ).toHaveCount(0);
          await expect(page.getByTestId("billing-status-notice")).toHaveCount(
            0,
          );
          break;

        case "CANCELING":
          // The date is when access ends, not a renewal — and the plan is still the paid one.
          await expect(subscription).toContainText("Access until");
          await expect(subscription).not.toContainText("Renews");
          await expect(
            page.getByTestId("billing-cancel-scheduled"),
          ).toContainText("Cancels on");
          await expect(
            page.getByTestId("billing-cancel-scheduled"),
          ).toContainText(
            `You keep ${PLAN_LABEL[expected.userPlan]} until then`,
          );
          // No plan change is offered while the cancellation stands: the API would refuse it.
          await expect(page.getByTestId("plan-action-STARTER")).toHaveCount(0);
          await expect(page.getByTestId("plan-hint-STARTER")).toHaveText(
            "Resume your subscription in Manage billing to change plan",
          );
          await expect(page.getByTestId("plan-hint-FREE")).toHaveText(
            "Scheduled at the end of your current period",
          );
          break;

        case "PAST_DUE":
          // Access is kept during Stripe's retry window; the page warns instead of downgrading.
          await expect(page.getByTestId("billing-status-notice")).toContainText(
            "Your last payment did not go through",
          );
          await expect(
            page.getByTestId("billing-cancel-scheduled"),
          ).toHaveCount(0);
          break;

        case "CANCELED":
          await expect(page.getByTestId("billing-status-notice")).toContainText(
            "Your subscription has ended",
          );
          // The mirror still carries the ended subscription's cadence, period and cancellation
          // date. None of it is a future, so none of it may be shown as one.
          await expect(page.getByTestId("billing-interval")).toHaveCount(0);
          await expect(page.getByTestId("billing-period-end")).toHaveCount(0);
          await expect(
            page.getByTestId("billing-cancel-scheduled"),
          ).toHaveCount(0);
          await expect(subscription).not.toContainText("Renews");
          // A lapsed customer buys back the plan they left — through Checkout, since nothing is
          // left to change — and the page names it for what it is. Any other plan is an upgrade.
          await expect(
            page.getByTestId(`plan-action-${persona.subscribedPlan}`),
          ).toHaveText(`Resubscribe to ${PLAN_LABEL[persona.subscribedPlan]}`);
          await expect(
            page.getByTestId(`plan-action-${persona.subscribedPlan}`),
          ).toHaveAttribute("data-action", "CHECKOUT");
          await expect(
            page.getByTestId(`plan-action-${persona.subscribedPlan}`),
          ).toBeEnabled();
          await expect(page.getByTestId("plan-action-STARTER")).toHaveText(
            "Upgrade to Starter",
          );
          break;
      }

      expect(stripeRequests).toEqual([]);
    });
  });
}
