import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { request as playwrightRequest } from "@playwright/test";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Dashboard for a signed-in customer (PRO persona): the ETF market overview, the match count
 * and the matches beside it.
 *
 * Needs `pnpm test:personas:seed`. The market overview is the same deterministic ETF fixture the
 * Guest suite reads — proving the point rather than assuming it: a fund closed where it closed, and
 * signing in changes nothing about it, while the matches stay this viewer's own.
 */

function qaRows(page: Page) {
  return page.getByTestId("dashboard-signal-row");
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible()) {
    await reject.click();
  }
}

test.describe("PRO_USER dashboard", () => {
  test("shows a customer exactly the market overview a Guest sees", async ({ page }) => {
    // Signed in: the page's own request context carries the session cookie.
    const signedIn = await page.request.get(`${apiBaseUrl()}/market-overview`);
    expect(signedIn.status()).toBe(200);
    const asCustomer = (await signedIn.json()) as MarketOverviewResponse;
    // A fresh context with no cookies at all.
    const anonymous = await playwrightRequest.newContext();
    const asGuest = (await (
      await anonymous.get(`${apiBaseUrl()}/market-overview`)
    ).json()) as MarketOverviewResponse;
    await anonymous.dispose();

    expect(asCustomer.groups).toEqual(asGuest.groups);
    expect(asCustomer.asOf).toBe(asGuest.asOf);
    // Nothing about the viewer is in it.
    const serialized = JSON.stringify(asCustomer);
    expect(serialized).not.toMatch(/@|plan|PRO_USER|userId/);

    await page.goto("/");
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    const spy = asCustomer.groups[0]?.instruments[0];
    expect(spy?.ticker).toBe("SPY");
    await expect(page.getByTestId("market-overview-row-SPY")).toBeVisible();
    await expect(page.getByTestId("market-overview-SPY-sparkline")).toBeVisible();
    for (const group of ["BENCHMARKS", "US_SECTORS", "MACRO_ALTERNATIVES"]) {
      await expect(page.getByTestId(`market-overview-group-${group}`)).toBeVisible();
    }
  });

  test("starts a backtest from the Backtests area, not from a Dashboard button", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-matches-card")).toBeVisible();
    // The Dashboard's own call to action is gone…
    await expect(page.getByTestId("dashboard-run-backtest")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-page").getByText(/run backtest/i)).toHaveCount(0);

    // …and the way to a backtest is unchanged: the navigation, then the area's own action.
    await page
      .getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("link", { name: "Backtests" })
      .click();
    await expect(page).toHaveURL(/\/backtests$/);
    await page.getByRole("link", { name: "New backtest", exact: true }).click();

    await expect(page).toHaveURL(/\/backtests\/new$/);
    await expect(page.getByTestId("backtest-benchmark")).toBeVisible();
    await expect(page.getByTestId("sign-in-prompt")).toHaveCount(0);
  });

  test("offers exactly the S&P 500 benchmark and nothing else", async ({
    page,
  }) => {
    // The API first: the catalog the picker is built from.
    const response = await page.request.get(`${apiBaseUrl()}/benchmarks`);
    expect(response.status()).toBe(200);
    const catalog = (await response.json()) as { code: string; name: string }[];
    expect(catalog.map(({ code, name }) => ({ code, name }))).toEqual([
      { code: "SP500", name: "S&P 500" },
    ]);

    await page.goto("/backtests/new");
    const benchmark = page.getByTestId("backtest-benchmark");
    await expect(benchmark).toBeVisible();
    // The form enables its selects only once the catalog has arrived; reading the options before
    // that would assert against the placeholder.
    await expect(benchmark).toBeEnabled();

    const options = await benchmark.locator("option").evaluateAll((elements) =>
      elements.map((element) => ({
        value: (element as HTMLOptionElement).value,
        label: element.textContent?.trim() ?? "",
      })),
    );

    // Exactly the one product option beside the empty placeholder — not "contains S&P 500", which
    // a leaked fixture or an internal index series would also satisfy.
    expect(options.filter((option) => option.value !== "")).toEqual([
      { value: "SP500", label: "S&P 500" },
    ]);
  });

  test("reflects the rows this viewer's dashboard returned", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    await expect(page.getByTestId("dashboard-matches-total")).toBeVisible();

    const rows = await qaRows(page).count();
    await expect(page.getByTestId("dashboard-matches-total")).toHaveText(
      String(rows),
    );

    const active = await qaRows(page)
      .filter({ has: page.locator('[data-state="ACTIVE"]') })
      .count();
    const waiting = await qaRows(page)
      .filter({ has: page.locator('[data-state="PENDING_TRIGGER"]') })
      .count();
    await expect(page.getByTestId("dashboard-matches-breakdown")).toHaveText(
      `${active} active · ${waiting} waiting`,
    );
  });

  test("leaves the signal table's filtering and row links working", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-signals")).toBeVisible();
    const before = await qaRows(page).count();
    expect(before).toBeGreaterThan(0);

    await page
      .getByTestId("dashboard-state-filter")
      .getByRole("button", { name: /^Waiting/ })
      .click();
    await expect(
      qaRows(page).filter({ has: page.locator('[data-state="ACTIVE"]') }),
    ).toHaveCount(0);

    await page
      .getByTestId("dashboard-state-filter")
      .getByRole("button", { name: /^All/ })
      .click();
    await expect(qaRows(page)).toHaveCount(before);

    // A row still goes to Stock Details, not to a backtest.
    await qaRows(page).first().click();
    await expect(page).toHaveURL(/\/stocks\/QATEST\d$/);
  });

  test("fits a 390px phone for a signed-in viewer, mobile navigation included", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await dismissConsent(page);
    await expect(page.getByTestId("dashboard-run-backtest")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-card")).toBeVisible();
    await expect(page.getByTestId("market-overview-category")).toBeVisible();
    await expect(page.getByTestId("market-overview-row-SPY")).toBeVisible();
    for (const period of ["1W", "1M", "3M", "6M", "YTD", "1Y"]) {
      await expect(page.getByTestId(`market-overview-return-SPY-${period}`)).toBeVisible();
    }
    // A phone card carries the six returns and no trend line.
    await expect(page.getByTestId("market-overview-SPY-sparkline")).toBeHidden();
    await expect(qaRows(page).first()).toBeAttached();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    const nav = page.getByRole("navigation", { name: "Primary mobile" });
    await nav.getByRole("link", { name: /Backtests/ }).click();
    await expect(page).toHaveURL(/\/backtests$/);
  });
});
