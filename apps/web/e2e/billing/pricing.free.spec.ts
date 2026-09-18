import { BILLING_CATALOG_ENTRIES } from "@intrinsic/contracts";
import { expect, test } from "@playwright/test";
import { readBillingStatus } from "../utils/billing";

/**
 * The public price list, as a signed-in FREE user sees it (PRICING-001).
 *
 * A signed-in viewer gets exactly the `/billing` behaviour on `/pricing`: the same card states from
 * the same server status, and the same Checkout call. No Stripe page is opened and no Checkout
 * Session is created: `/billing/status` and `/billing/checkout` are answered in the browser, for the
 * same reason `billing.free.spec.ts` stubs Checkout — a real call would give the shared FREE_USER a
 * Stripe footprint and make the suite depend on Stripe (`stripe-billing-v1.md` section 27). Every
 * other request that leaves the local stack is aborted and fails the spec.
 */

const STUB_CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_stub";

test.describe("FREE pricing", () => {
  test("shows the persona's own plan state from the server", async ({
    page,
  }) => {
    const status = await readBillingStatus(page);
    await page.goto("/pricing");

    await expect(page.getByTestId("plan-card-FREE")).toHaveAttribute(
      "data-current",
      "true",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("plan-action-FREE")).toBeDisabled();
    if (status.billingEnabled) {
      await expect(page.getByTestId("plan-action-PRO")).toHaveText(
        "Upgrade to Pro",
      );
    } else {
      // An environment without a biller says so and offers nothing to buy.
      await expect(page.getByTestId("billing-unavailable")).toBeVisible();
      await expect(page.getByTestId("plan-action-PRO")).toHaveCount(0);
    }
    await expect(page.getByTestId("sign-in-prompt")).toHaveCount(0);
  });

  test("starts the existing Checkout with only a catalog key", async ({
    page,
  }) => {
    const external: string[] = [];
    let sentBody: unknown = null;

    await page.route(
      (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
      (route) => {
        const url = route.request().url();
        if (url.startsWith(STUB_CHECKOUT_URL)) {
          return route.fulfill({ status: 200, body: "stripe checkout stub" });
        }
        external.push(url);
        return route.abort();
      },
    );
    await page.route("**/billing/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plan: "FREE",
          billingEnabled: true,
          subscription: null,
          canStartCheckout: true,
          canOpenPortal: false,
          canChangePlan: false,
          catalog: BILLING_CATALOG_ENTRIES,
        }),
      }),
    );
    await page.route("**/billing/checkout", async (route) => {
      sentBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ checkoutUrl: STUB_CHECKOUT_URL }),
      });
    });

    await page.goto("/pricing");
    await page.getByRole("radio", { name: "Yearly" }).check();
    const pro = page.getByTestId("plan-action-PRO");
    await expect(pro).toHaveText("Upgrade to Pro", { timeout: 20_000 });
    await expect(pro).toHaveAttribute("data-price-key", "PRO_YEARLY");
    await pro.click();

    await expect
      .poll(() => sentBody, { timeout: 20_000 })
      .toEqual({ priceKey: "PRO_YEARLY" });
    await expect
      .poll(() => page.url(), { timeout: 20_000 })
      .toContain(STUB_CHECKOUT_URL);
    expect(external).toEqual([]);

    // Arriving at "Checkout" granted nothing.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect((await readBillingStatus(page)).plan).toBe("FREE");
  });
});
