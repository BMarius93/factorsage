import { expect, test, type Page } from "../fixtures";

/**
 * A signed-in customer's Dashboard: the same built-in rows a Guest sees, and nothing else — the
 * page is the signal table alone, and choosing which monitors feed it happens on the Monitors page
 * (`e2e/builtins/collections.user.spec.ts`).
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

test.describe("PRO_USER dashboard", () => {
  test("keeps the built-in signals after signing in, with no configuration panel", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("dashboard-guest-notice")).toHaveCount(0);
    await expect(qaRows(page)).toHaveCount(3);

    // Signing in must not make the public content disappear, and must not add a settings panel.
    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-signals").getByRole("link", { name: "Backtest" }),
    ).toHaveCount(0);
  });

  test("reaches the strategy, the list and the monitor behind a row", async ({
    page,
  }) => {
    await page.goto("/");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();

    await expect(
      row.getByRole("link", { name: "QA Built-in Trend" }),
    ).toHaveAttribute("href", /\/strategies\/[0-9a-f-]{36}$/);
    await expect(
      row.getByRole("link", { name: "QA Built-in Leaders" }),
    ).toHaveAttribute("href", /\/lists\/[0-9a-f-]{36}$/);
    await expect(row.getByRole("link", { name: MONITOR_A })).toHaveAttribute(
      "href",
      /\/monitors\/[0-9a-f-]{36}$/,
    );
  });

  test("shows a customer a built-in monitor read-only", async ({ page }) => {
    await page.goto("/");
    await qaRows(page)
      .filter({ hasText: MONITOR_A })
      .first()
      .getByRole("link", { name: MONITOR_A })
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("edit-monitor")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Run backtest" }),
    ).toBeVisible();
  });
});
