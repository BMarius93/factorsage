import { expect, test, type Page } from "../fixtures";

/**
 * A signed-in customer's Dashboard: the same built-in activity a Guest sees, and nothing else — the
 * page is the Monitor Activity feed with Market watch beside it, and choosing which monitors feed it
 * happens on the Monitors page (`e2e/builtins/collections.user.spec.ts`).
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`, which also clears any preference a
 * previous run left behind.
 */

const MONITOR_A = "QA Built-in Monitor A";

function qaRows(page: Page) {
  return page
    .getByTestId("dashboard-activity-row")
    .filter({ hasText: /QA Built-in Monitor/ });
}

test.describe("PRO_USER dashboard", () => {
  test("keeps the built-in activity after signing in, with no configuration panel", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    await expect(qaRows(page)).toHaveCount(4);

    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(
      page
        .getByTestId("dashboard-activity")
        .getByRole("link", { name: "Backtest" }),
    ).toHaveCount(0);
  });

  test("reaches the monitor behind an event", async ({ page }) => {
    await page.goto("/");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    await expect(
      row.getByRole("link", { name: MONITOR_A }).first(),
    ).toHaveAttribute("href", /\/monitors\/[0-9a-f-]{36}$/);
  });

  test("shows a customer a built-in monitor read-only, with its Signal table", async ({
    page,
  }) => {
    await page.goto("/");
    await qaRows(page)
      .filter({ hasText: MONITOR_A })
      .first()
      .getByRole("link", { name: MONITOR_A })
      .first()
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("edit-monitor")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Run backtest" }),
    ).toBeVisible();

    // Active first, then ended — each with its Why. The Monitor's own table is its full history:
    // the last occurrence ended before the Dashboard's 30-day window, so only this page lists it.
    const rows = page.getByTestId("monitor-signal-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByTestId("monitor-signal-status")).toHaveText(
      "Active",
    );
    for (const ended of [rows.nth(1), rows.nth(2)]) {
      await expect(ended.getByTestId("monitor-signal-status")).toHaveText(
        "Ended · conditions no longer hold",
      );
      await expect(ended.getByTestId("monitor-why")).toContainText(
        "did not hold",
      );
    }
    await expect(page.getByTestId("monitor-coverage-line")).toContainText(
      "Evaluated through the",
    );
  });
});
