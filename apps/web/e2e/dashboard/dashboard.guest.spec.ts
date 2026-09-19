import { expect, test, type Page } from "../fixtures";

/**
 * The Dashboard as a first-time visitor meets it.
 *
 * Needs `pnpm test:securities:seed && pnpm test:builtins:seed`: the QA built-ins put one security
 * active under two built-in monitors and one setup waiting for its trigger, so the rows asserted
 * here are exact.
 *
 * The page is only the signals table. Which monitors feed it is configured on the Monitors page,
 * and the Guest's side of that is covered in `e2e/builtins/collections.guest.spec.ts`.
 */

const MONITOR_A = "QA Built-in Monitor A";
const MONITOR_B = "QA Built-in Monitor B";

function qaRows(page: Page) {
  return page
    .getByTestId("dashboard-signal-row")
    .filter({ hasText: /QA Built-in Monitor/ });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("guest dashboard", () => {
  test("shows the built-in monitors' current signals without an account", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId("dashboard-guest-notice")).toBeVisible();
    await expect(page.getByTestId("sign-in-link")).toBeVisible();

    const rows = qaRows(page);
    await expect(rows).toHaveCount(3);
    // The same security under two monitors is two rows.
    await expect(rows.filter({ hasText: "QATEST1" })).toHaveCount(2);
    const waiting = rows.filter({ hasText: "QATEST2" });
    await expect(waiting).toContainText("Waiting for trigger");
    await expect(waiting).toContainText(
      "Waiting for: Price crosses above SMA 20D",
    );
    await expect(rows.filter({ hasText: MONITOR_A })).toContainText("Active");
    await expect(page.getByTestId("dashboard-freshness")).toContainText(
      "Updated",
    );
  });

  test("reports one signal per row with the agreed columns and no repeated call to action", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const table = page.getByTestId("dashboard-signals");
    await expect(table).toBeVisible();

    await expect(table.getByRole("columnheader")).toHaveText([
      "Stock",
      "Action",
      "Since",
      "Why",
      "Price",
      "Strategy",
      "List",
      "Monitor",
    ]);
    // "Since" says when each signal's state began (UI-025). Still removed deliberately: a Backtest
    // button on every single row.
    await expect(table.getByRole("link", { name: "Backtest" })).toHaveCount(0);
    // And no monitor configuration: that lives on the Monitors page now.
    await expect(page.getByTestId("dashboard-monitor")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("filters by state and by action, and composes the two", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(qaRows(page)).toHaveCount(3);

    const states = page.getByTestId("dashboard-state-filter");
    await states.getByRole("button", { name: /^Waiting/ }).click();
    await expect(qaRows(page)).toHaveCount(1);
    await expect(qaRows(page)).toContainText("QATEST2");

    await states.getByRole("button", { name: /^All/ }).click();
    await expect(qaRows(page)).toHaveCount(3);

    // The action filter is a dropdown, not a second pill group.
    const actions = page.getByTestId("dashboard-level-filter");
    await actions.selectOption("BUY");
    await expect(qaRows(page)).toHaveCount(3);
    await actions.selectOption("SELL");
    await expect(qaRows(page)).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-signals-filtered-empty"),
    ).toBeVisible();

    // State AND action.
    await actions.selectOption("BUY");
    await states.getByRole("button", { name: /^Active/ }).click();
    await expect(qaRows(page)).toHaveCount(2);
  });

  test("opens Stock Details from a row", async ({ page }) => {
    await page.goto("/dashboard");
    const row = qaRows(page).filter({ hasText: MONITOR_A }).first();
    // A click anywhere that is not itself a control opens the stock.
    await row.getByText("Buy 100%").click();
    await expect(page).toHaveURL(/\/stocks\/QATEST1$/);
  });

  test("links the strategy, the list and the monitor behind a row independently", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const row = qaRows(page)
      .filter({ hasText: MONITOR_B })
      .filter({ hasText: "QATEST2" });

    await row.getByRole("link", { name: "QA Built-in Trend" }).click();
    await expect(page.getByTestId("strategy-read-only")).toBeVisible();
    await expect(page.getByText("Price crosses above SMA 20D")).toBeVisible();

    await page.goBack();
    await qaRows(page)
      .filter({ hasText: MONITOR_B })
      .first()
      .getByRole("link", { name: "QA Built-in Newcomers" })
      .click();
    await expect(page.getByTestId("list-detail")).toBeVisible();
    await expect(page.getByTestId("built-in-badge")).toBeVisible();
    await expect(page.getByTestId("add-stocks-button")).toHaveCount(0);

    await page.goBack();
    await qaRows(page)
      .filter({ hasText: MONITOR_B })
      .first()
      .getByRole("link", { name: MONITOR_B })
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
  });

  test("renders phone record cards without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(qaRows(page)).toHaveCount(3);
    // Record cards: every row fits the phone's width, and the page never scrolls sideways.
    const card = qaRows(page).first();
    const box = await card.boundingBox();
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(390);
    // The three relationships stay legible inside the card rather than being cut off.
    await expect(card).toContainText("Strategy");
    await expect(card).toContainText("List");
    await expect(card).toContainText("Monitor");
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
