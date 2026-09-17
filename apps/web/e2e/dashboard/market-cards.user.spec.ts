import { expect, test, type Page } from "@playwright/test";

/**
 * The overview strip for a signed-in customer, and the backtest invariants beside it.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`. The market values are the
 * deterministic QA market-reference fixtures, identical to the ones the Guest suite asserts —
 * proving the point rather than assuming it: an index closed where it closed, and signing in
 * changes nothing about it.
 */

function qaRows(page: Page) {
  return page.getByTestId("dashboard-signal-row");
}

test.describe("PRO_USER dashboard overview cards", () => {
  test("shows a customer the same market data a Guest sees", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    await expect(
      page.getByTestId("dashboard-market-value-SP500_INDEX"),
    ).toHaveText("7,637");
    await expect(
      page.getByTestId("dashboard-market-value-DJIA_INDEX"),
    ).toHaveText("51,778");
    await expect(
      page.getByTestId("dashboard-market-value-VIX_INDEX"),
    ).toHaveText("15.43");
    await expect(
      page.getByTestId("dashboard-market-change-SP500_INDEX"),
    ).toHaveText("+1.13%");
    // No guest notice, and the same five cards.
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-overview")).toBeVisible();
  });

  test("takes Run Backtest straight to the canonical New Backtest route", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const card = page.getByTestId("dashboard-run-backtest");

    // A real link for a signed-in viewer, so the browser's own affordances work.
    await expect(card).toHaveAttribute("href", "/backtests/new");
    await card.click();

    await expect(page).toHaveURL(/\/backtests\/new$/);
    await expect(page.getByTestId("backtest-benchmark")).toBeVisible();
    // No prompt: the viewer has an account.
    await expect(page.getByTestId("sign-in-prompt")).toHaveCount(0);
  });

  test("still offers S&P 500 and never an internal market reference as a benchmark", async ({
    page,
  }) => {
    await page.goto("/backtests/new");
    const benchmark = page.getByTestId("backtest-benchmark");
    await expect(benchmark).toBeVisible();
    // The form enables its selects only once the catalog has arrived; reading the options before
    // that would assert against the placeholder.
    await expect(benchmark).toBeEnabled();
    await expect(benchmark.locator("option")).not.toHaveCount(1);

    const options = await benchmark
      .locator("option")
      .evaluateAll((elements) =>
        elements.map((element) => (element as HTMLOptionElement).value),
      );

    // The product benchmark is selectable …
    expect(options).toContain("SP500");
    // … and the Dashboard's index series are not, however active they are.
    expect(options).not.toContain("SP500_INDEX");
    expect(options).not.toContain("DJIA_INDEX");
    expect(options).not.toContain("VIX_INDEX");
    expect(options.filter((value) => value.endsWith("_INDEX"))).toEqual([]);
  });

  test("reflects the rows this viewer's dashboard returned", async ({
    page,
  }) => {
    await page.goto("/dashboard");
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
    await page.goto("/dashboard");
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

  test("fits a 390px phone for a signed-in viewer too", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-overview")).toBeVisible();
    await expect(page.getByTestId("dashboard-run-backtest")).toBeVisible();
    await expect(page.getByTestId("dashboard-matches-card")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
