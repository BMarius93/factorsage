import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { request as playwrightRequest } from "@playwright/test";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Dashboard for a signed-in customer (PRO persona): the Monitor Activity feed, with the Market
 * watch sidebar beside it on a wide desktop.
 *
 * Needs `pnpm test:personas:seed`. Market watch reads the same deterministic ETF fixture the Guest
 * suite reads — proving the point rather than assuming it: a fund closed where it closed, and
 * signing in changes nothing about it, while the activity stays this viewer's own.
 */

function qaRows(page: Page) {
  return page.getByTestId("dashboard-activity-row");
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible()) {
    await reject.click();
  }
}

test.describe("PRO_USER dashboard", () => {
  test("shows a customer exactly the market data a Guest sees", async ({
    page,
  }) => {
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

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    const spy = asCustomer.groups[0]?.instruments[0];
    expect(spy?.ticker).toBe("SPY");
    await expect(page.getByTestId("market-watch-row-SPY")).toBeVisible();
    await expect(page.getByTestId("market-watch-SPY-sparkline")).toBeVisible();
    for (const group of ["BENCHMARKS", "US_SECTORS", "MACRO_ALTERNATIVES"]) {
      await expect(
        page.getByTestId(`market-watch-group-${group}`),
      ).toBeVisible();
    }
    await expect(
      page.locator('[data-testid^="market-watch-row-"]'),
    ).toHaveCount(20);
    // The customer's own activity, beside it, in the same three columns at every desktop width.
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();
    await expect(
      page.getByTestId("dashboard-activity").getByRole("columnheader"),
    ).toHaveText(["Stock", "Signal", "Conditions"]);
  });

  test("starts a backtest from the Backtests area, not from a Dashboard button", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();
    // The Dashboard's own call to action is gone…
    await expect(page.getByTestId("dashboard-run-backtest")).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-page").getByText(/run backtest/i),
    ).toHaveCount(0);

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

  test("offers exactly the SPY benchmark and nothing else", async ({
    page,
  }) => {
    // The API first: the catalog the picker is built from.
    const response = await page.request.get(`${apiBaseUrl()}/benchmarks`);
    expect(response.status()).toBe(200);
    const catalog = (await response.json()) as { code: string; name: string }[];
    // Named for the series it is, the SPY ETF — not for the index it tracks (BT-1).
    expect(catalog.map(({ code, name }) => ({ code, name }))).toEqual([
      { code: "SP500", name: "SPY" },
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

    // Exactly the one product option beside the empty placeholder — not "contains SPY", which
    // a leaked fixture or an internal index series would also satisfy.
    expect(options.filter((option) => option.value !== "")).toEqual([
      { value: "SP500", label: "SPY" },
    ]);
  });

  test("lists this viewer's activity with no summary card, and its rows still open Stock Details", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-activity")).toBeVisible();
    await expect(page.getByTestId("dashboard-overview")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-card")).toHaveCount(0);
    expect(await qaRows(page).count()).toBeGreaterThan(0);

    // A row goes to Stock Details, not to a backtest — from anywhere in the row that is not a
    // control, its event state included.
    await qaRows(page).first().getByTestId("dashboard-event-state").click();
    await expect(page).toHaveURL(/\/stocks\/QATEST\d$/);
  });

  test("fits a 390px phone for a signed-in viewer, with no Market watch and no market read", async ({
    page,
  }) => {
    const marketReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/market-overview")) {
        marketReads.push(request.url());
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await dismissConsent(page);
    await expect(page.getByTestId("dashboard-run-backtest")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-matches-card")).toHaveCount(0);
    await expect(qaRows(page).first()).toBeVisible();
    // Market watch is a wide-desktop sidebar: on a phone it is not there at all.
    await expect(page.getByTestId("market-watch")).toHaveCount(0);
    await expect(page.locator('[data-testid$="-sparkline"]')).toHaveCount(0);
    expect(marketReads).toEqual([]);

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
