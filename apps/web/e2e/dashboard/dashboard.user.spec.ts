import { expect, test, type Page } from "@playwright/test";

/**
 * A signed-in user's Dashboard: the same built-in rows a Guest sees, plus the right to hide a
 * built-in monitor — a preference that persists for this account only.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`, which also clears any preference a
 * previous run left behind.
 */

const MONITOR_A = "QA Built-in Monitor A";

function qaRows(page: Page) {
  return page
    .getByTestId("dashboard-signal-row")
    .filter({ hasText: /QA Built-in Monitor/ });
}

function card(page: Page) {
  return page.getByTestId("dashboard-monitor").filter({ hasText: MONITOR_A });
}

test.describe("PRO_USER dashboard", () => {
  test("hides a built-in monitor for this account and keeps the choice", async ({
    page,
    browser,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    await expect(qaRows(page)).toHaveCount(3);

    const toggle = card(page).getByTestId("dashboard-monitor-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    try {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(qaRows(page)).toHaveCount(2);
      await expect(qaRows(page).filter({ hasText: MONITOR_A })).toHaveCount(0);

      await page.reload();
      await expect(
        card(page).getByTestId("dashboard-monitor-toggle"),
      ).toHaveAttribute("aria-checked", "false");
      await expect(qaRows(page)).toHaveCount(2);

      // A visitor with no session still sees the shared monitor: the preference is per account.
      const guest = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const guestPage = await guest.newPage();
      await guestPage.goto("/dashboard");
      await expect(qaRows(guestPage)).toHaveCount(3);
      await guest.close();
    } finally {
      const current = card(page).getByTestId("dashboard-monitor-toggle");
      if ((await current.getAttribute("aria-checked")) === "false") {
        await current.click();
        await expect(current).toHaveAttribute("aria-checked", "true");
      }
    }
    await expect(qaRows(page)).toHaveCount(3);
  });

  test("links a row to a five-year backtest of the same strategy and list", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await qaRows(page)
      .filter({ hasText: MONITOR_A })
      .first()
      .getByRole("link", { name: "Backtest" })
      .click();
    await expect(page).toHaveURL(
      /\/backtests\/new\?strategyId=.+&stockListId=.+/,
    );
    await expect(page.getByTestId("backtest-strategy")).toHaveValue(/.+/);
    await expect(
      page.getByTestId("backtest-strategy").locator("option:checked"),
    ).toHaveText("QA Built-in Trend");
    await expect(
      page.getByTestId("backtest-list").locator("option:checked"),
    ).toHaveText("QA Built-in Leaders");
  });

  test("shows a customer a built-in monitor read-only", async ({ page }) => {
    await page.goto("/dashboard");
    await card(page).getByRole("link", { name: MONITOR_A }).click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("edit-monitor")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Backtest this monitor" }),
    ).toBeVisible();
  });
});
