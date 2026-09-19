import { BILLING_CATALOG, PAID_PLANS } from "@intrinsic/contracts";
import { expect, test, type Page } from "../fixtures";
import { submitSignInForm } from "../utils/sign-in";
import { qaPersona } from "../utils/env";

/**
 * The public price list, as a visitor without an account sees it (PRICING-001, DEC-001).
 *
 * `/pricing` is guest-readable; `/billing` is not. A Guest sees the real catalog, is asked for an
 * account in place by every plan button, and is never sent to — and never makes a request to — any
 * billing endpoint. Signing in from the prompt comes straight back here (UX-003).
 *
 * Hermetic: every request that leaves the local stack is aborted and recorded, and the spec fails
 * if there was one. Nothing here reads stock data, so the API has no reason to reach FMP either.
 */

const PLANS = ["FREE", "STARTER", "PRO"] as const;

type Traffic = { readonly external: string[]; readonly billing: string[] };

/** Seals the browser to the local stack and records every billing call the page makes. */
async function watchTraffic(page: Page): Promise<Traffic> {
  const traffic: Traffic = { external: [], billing: [] };
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    (route) => {
      traffic.external.push(route.request().url());
      return route.abort();
    },
  );
  page.on("request", (request) => {
    const { hostname, pathname } = new URL(request.url());
    if (hostname === "localhost" && pathname.startsWith("/billing/")) {
      traffic.billing.push(`${request.method()} ${pathname}`);
    }
  });
  return traffic;
}

async function openPricing(page: Page) {
  await page.goto("/pricing");
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByTestId("sign-in-link")).toBeVisible();
  await expect(page.getByTestId("billing-catalog")).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

const usd = (minorUnits: number) => `$${minorUnits / 100}`;

test.describe("guest pricing", () => {
  test("opens without an account and shows the canonical catalog", async ({
    page,
  }) => {
    const traffic = await watchTraffic(page);
    await openPricing(page);

    await expect(
      page.getByRole("heading", { level: 1, name: "Pricing" }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="plan-card-"]')).toHaveCount(3);
    for (const plan of PAID_PLANS) {
      await expect(page.getByTestId(`plan-price-${plan}`)).toContainText(
        usd(BILLING_CATALOG[`${plan}_MONTHLY`].amountMinorUnits),
      );
    }

    await page.getByRole("radio", { name: "Yearly" }).check();
    for (const plan of PAID_PLANS) {
      await expect(page.getByTestId(`plan-price-${plan}`)).toContainText(
        usd(BILLING_CATALOG[`${plan}_YEARLY`].amountMinorUnits),
      );
    }

    // Reachable from the guest topbar as well as by URL.
    await expect(page.getByTestId("pricing-link")).toHaveAttribute(
      "href",
      "/pricing",
    );
    expect(traffic.billing).toEqual([]);
    expect(traffic.external).toEqual([]);
  });

  test("asks for an account in place from every plan, and never calls Checkout", async ({
    page,
  }) => {
    const traffic = await watchTraffic(page);
    await openPricing(page);

    for (const plan of PLANS) {
      const action = page.getByTestId(`plan-action-${plan}`);
      await expect(action).toHaveJSProperty("tagName", "BUTTON");
      await expect(action).not.toHaveAttribute("data-price-key", /.*/);
      await action.click();

      const prompt = page.getByTestId("sign-in-prompt");
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText("Sign in to choose a plan");
      await expect(
        prompt.getByRole("link", { name: "Sign in" }),
      ).toHaveAttribute("href", "/login?next=%2Fpricing");
      await expect(
        prompt.getByRole("link", { name: "Create an account" }),
      ).toHaveAttribute("href", "/register?next=%2Fpricing");
      // Still on the price list: nothing navigated.
      await expect(page).toHaveURL(/\/pricing$/);

      await prompt.getByRole("button", { name: "Close dialog" }).click();
      await expect(prompt).toHaveCount(0);
    }

    expect(traffic.billing).toEqual([]);
    expect(traffic.external).toEqual([]);
  });

  test("operates a plan action from the keyboard", async ({ page }) => {
    await openPricing(page);

    await page.getByTestId("plan-action-PRO").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sign-in-prompt")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sign-in-prompt")).toHaveCount(0);
  });

  test("comes straight back to pricing after signing in from the prompt", async ({
    page,
  }) => {
    const traffic = await watchTraffic(page);
    await openPricing(page);

    await page.getByTestId("plan-action-PRO").click();
    await page
      .getByTestId("sign-in-prompt")
      .getByRole("link", { name: "Sign in" })
      .click();
    await expect(page).toHaveURL(/\/login\?next=%2Fpricing$/);

    await submitSignInForm(page, qaPersona("PRO_USER"));

    await expect(page).toHaveURL(/\/pricing$/, { timeout: 20_000 });
    await expect(page.getByTestId("account-menu-trigger")).toBeVisible();
    // Now a signed-in viewer: the cards reflect the persona's persisted plan.
    await expect(page.getByTestId("plan-card-PRO")).toHaveAttribute(
      "data-current",
      "true",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("pricing-billing-link")).toBeVisible();

    // Signing in read billing status; nothing tried to buy anything.
    expect(traffic.billing).toContain("GET /billing/status");
    expect(traffic.billing.filter((call) => call.includes("checkout"))).toEqual(
      [],
    );
    expect(traffic.external).toEqual([]);
  });

  test("still sends a Guest from /billing to sign in", async ({ page }) => {
    await page.goto("/billing");
    await expect(page).toHaveURL(/\/login\?next=%2Fbilling$/, {
      timeout: 20_000,
    });
  });

  test("lays out at desktop width without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openPricing(page);
    await expectNoHorizontalScroll(page);

    // Three abreast: the cards share one top edge.
    const tops = await page
      .locator('[data-testid^="plan-card-"]')
      .evaluateAll((cards) =>
        cards.map((card) => Math.round(card.getBoundingClientRect().y)),
      );
    expect(new Set(tops).size).toBe(1);
  });

  test("stacks the plans on a phone without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPricing(page);
    await expectNoHorizontalScroll(page);

    const lefts = await page
      .locator('[data-testid^="plan-card-"]')
      .evaluateAll((cards) =>
        cards.map((card) => Math.round(card.getBoundingClientRect().x)),
      );
    expect(lefts).toHaveLength(3);
    expect(new Set(lefts).size).toBe(1);
    await expect(page.getByRole("radio", { name: "Yearly" })).toBeVisible();
    await expect(page.getByTestId("pricing-link")).toBeVisible();

    await page.getByTestId("plan-action-PRO").click();
    await expect(page.getByTestId("sign-in-prompt")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
