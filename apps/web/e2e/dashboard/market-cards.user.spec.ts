import { expect, test, type Page } from "@playwright/test";
import { apiBaseUrl } from "../utils/entitlements";

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
    await expect(page.getByTestId("dashboard-vix-status")).toHaveText("Normal");
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
    // The phone VIX card is the compact form — level and zone as text, no arc squeezed into 65px.
    await expect(page.getByTestId("dashboard-vix-status")).toHaveText("Normal");
    await expect(page.getByTestId("dashboard-vix-gauge")).toBeHidden();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
