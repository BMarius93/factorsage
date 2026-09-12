import { expect, test } from "@playwright/test";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * A guest has no billing identity at all.
 *
 * `docs/decisions/stripe-billing-v1.md` section 4 is explicit: guests cannot initiate Checkout or a
 * Portal session. This runs with no storage state, so every request here is genuinely unauthenticated
 * — the refusal comes from `CookieAuthGuard` before any billing code runs.
 */
test.describe("guest billing", () => {
  test("cannot read billing status or start any billing operation", async ({
    page,
  }) => {
    for (const [method, path] of [
      ["GET", "/billing/status"],
      ["POST", "/billing/checkout"],
      ["POST", "/billing/portal"],
      ["POST", "/billing/change"],
      ["POST", "/billing/refresh"],
    ] as const) {
      const response =
        method === "GET"
          ? await page.request.get(`${apiBaseUrl()}${path}`, {
              failOnStatusCode: false,
            })
          : await page.request.post(`${apiBaseUrl()}${path}`, {
              data: { priceKey: "PRO_MONTHLY" },
              failOnStatusCode: false,
            });

      expect(response.status(), `${method} ${path} was not refused`).toBe(401);
    }
  });

  test("is sent to sign in rather than to a purchase", async ({ page }) => {
    await page.goto("/billing");
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  });

  test("cannot post an unsigned webhook to move a plan", async ({ page }) => {
    // The webhook route is the one unauthenticated billing endpoint. Its only credential is a Stripe
    // signature, so an anonymous caller with a plausible payload must get nowhere.
    const response = await page.request.post(`${apiBaseUrl()}/webhooks/stripe`, {
      data: {
        id: "evt_forged",
        type: "customer.subscription.updated",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: { id: "sub_forged", customer: "cus_forged" } },
      },
      failOnStatusCode: false,
    });
    // 400 when billing is configured (no signature), 503 when it is not. Never 200.
    expect([400, 503]).toContain(response.status());
  });
});
