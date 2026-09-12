import { expect, test } from "@playwright/test";
import { apiBaseUrl, readEntitlements } from "../utils/entitlements";

/**
 * What a signed-out visitor may do.
 *
 * `GUEST` is not an account: `docs/decisions/entitlements-v1.md` derives it from the absence of a
 * session and forbids creating a row for it, so this project has no storage state and nothing to
 * seed.
 *
 * The split between the two halves below is deliberate and worth reading. The **public reads** are
 * asserted against the API, because the web app currently puts every product route — `/stocks`
 * included — behind `RequireAuth`, so there is no signed-out browsing surface to drive. That is a
 * UI gap, not a contradiction in the decision document: the entitlement exists and the API honours
 * it, and building a public stocks page would be a product change this suite has no business
 * making. The **refusals** are asserted through the browser, because that is where a user meets
 * them.
 */
test.describe("guest entitlements", () => {
  test("resolves guest entitlements without creating an account", async ({
    page,
  }) => {
    const payload = await readEntitlements(page);

    expect(payload.principal).toBe("GUEST");
    expect(payload.plan).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.entitlements.tier).toBe("GUEST");
    expect(payload.entitlements.authenticated).toBe(false);
  });

  test("may search stocks and read details with unrestricted history", async ({
    page,
  }) => {
    const search = await page.request.get(
      `${apiBaseUrl()}/stocks/search?q=QATEST`,
    );
    expect(
      search.status(),
      "Stock search is a public read for guests. If this is 401, the entitlement matrix and the " +
        "route guard disagree.",
    ).toBe(200);

    const details = await page.request.get(`${apiBaseUrl()}/stocks/QATEST1`);
    expect(details.status()).toBe(200);

    // The one restriction a reader might expect and the decision document explicitly rules out:
    // backtest depth is capped per plan, Stock Details history is not.
    const payload = await readEntitlements(page);
    expect(payload.entitlements.stocks.canSearch).toBe(true);
    expect(payload.entitlements.stocks.canViewDetails).toBe(true);
    expect(payload.entitlements.stocks.maxHistoricalYears).toBeNull();
  });

  test("may read built-in content and demo backtests", async ({ page }) => {
    const { entitlements } = await readEntitlements(page);

    expect(entitlements.builtInContent.canViewLists).toBe(true);
    expect(entitlements.builtInContent.canViewStrategies).toBe(true);
    expect(entitlements.backtests.canViewDemo).toBe(true);
  });

  test("cannot create lists, strategies, backtests or monitors", async ({
    page,
  }) => {
    const { entitlements } = await readEntitlements(page);

    expect(entitlements.lists.canCreateCustom).toBe(false);
    expect(entitlements.strategies.canCreateCustom).toBe(false);
    expect(entitlements.backtests.canRunLive).toBe(false);
    expect(entitlements.monitors.maxActive).toBe(0);

    // And the server refuses each of them outright, not merely the UI. A hand-written request is
    // the whole threat model here: a client that ignores the entitlements above must still fail.
    for (const path of ["/lists", "/strategies", "/backtests", "/monitors"]) {
      const response = await page.request.post(`${apiBaseUrl()}${path}`, {
        data: { name: "Guest attempt" },
      });
      expect(
        response.status(),
        `POST ${path} must refuse a request with no session`,
      ).toBe(401);
    }
  });

  test("is sent to sign in when opening an authenticated-only page", async ({
    page,
  }) => {
    for (const path of ["/lists", "/strategies", "/backtests", "/monitors"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
    }
  });

  test("offers a way into the product rather than a dead end", async ({
    page,
  }) => {
    await page.goto("/monitors");

    await expect(page).toHaveURL(/\/login$/);
    // The remedy for ENTITLEMENT_AUTH_REQUIRED is to sign in or register, and both are reachable.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toBeVisible();
  });
});
