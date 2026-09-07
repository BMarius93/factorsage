import { expect, test, type Page } from "@playwright/test";

/**
 * Full Strategy Builder journey for QA_USER.
 *
 * Precondition beyond the usual stack + `pnpm test:users:seed`: none. A strategy references the
 * static series catalog in `@intrinsic/contracts`, so this suite needs no seeded securities, no
 * market data and no provider — unlike the lists journey.
 */

const STRATEGY_NAME = "E2E deep value";
const RENAMED = "E2E deep value (edited)";

function card(page: Page, name: string) {
  return page.getByTestId("strategies-grid").locator("li").filter({ hasText: name });
}

/**
 * Best-effort teardown through the product UI, so a failure partway through cannot leave the
 * shared QA_USER persona accumulating test strategies.
 */
async function deleteStrategyIfPresent(page: Page, name: string) {
  try {
    await page.goto("/strategies");
    await expect(
      page.getByTestId("strategies-grid").or(page.getByTestId("strategies-empty")),
    ).toBeVisible();
    const row = card(page, name);
    if ((await row.count()) === 0) {
      return;
    }
    await row.first().getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(card(page, name)).toHaveCount(0);
  } catch {
    // Teardown is best effort; the assertions that matter are in the tests themselves.
  }
}

/** No page may scroll sideways: a signal must be definable without horizontal scrolling. */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally: ${overflow.scrollWidth}px content in ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe("strategy builder", () => {
  test.afterEach(async ({ page }) => {
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
    await deleteStrategyIfPresent(page, RENAMED);
  });

  test("creates, edits, reloads and deletes a strategy", async ({ page }) => {
    await page.goto("/strategies");
    await page.getByTestId("new-strategy-button").first().click();
    await expect(page).toHaveURL(/\/strategies\/new$/);

    // A new builder does not open to a wall of red. Scoped to the builder: a dev build renders
    // Next's own dev-tools alert region on every page.
    await expect(
      page.getByTestId("strategy-builder").getByRole("alert"),
    ).toHaveCount(0);
    await expect(page.getByTestId("save-strategy")).toBeDisabled();

    await page.getByLabel("Name").fill(STRATEGY_NAME);
    await page.getByTestId("add-level-BUY").click();

    // Price is above EMA 200D.
    const buyCard = page.getByTestId("level-card-BUY").first();
    await buyCard.getByTestId("metric-select").first().selectOption("PRICE:");
    await buyCard.getByTestId("operator-select").first().selectOption("IS_ABOVE");
    await buyCard.getByTestId("value-control").first().selectOption("EMA_200D");

    // ... AND Margin of Safety (DCF) is above 25%.
    await buyCard.getByTestId("add-condition").click();
    const second = buyCard.getByTestId("predicate-row").nth(1);
    await second.getByTestId("metric-select").selectOption("MARGIN_OF_SAFETY:DCF_FCFF");
    await second.getByTestId("value-control").fill("25");

    // The explanation panel must explain Margin of Safety correctly.
    await second.getByTestId("metric-select").click();
    const panel = page.getByTestId("explanation-panel");
    await expect(panel).toContainText("Margin of Safety (DCF (FCFF))");
    await expect(panel.getByTestId("help-formula")).toHaveText(
      "Margin of Safety = (Intrinsic Value - Price) / Intrinsic Value * 100",
    );
    await expect(panel.getByTestId("help-examples")).toContainText(
      "Intrinsic Value 100, Price 75",
    );
    // Margin of safety is not upside.
    await expect(panel.getByTestId("help-notes")).toContainText("33.33%");
    await expect(panel.getByTestId("help-not-evaluable")).toContainText(
      "zero or negative",
    );

    // A SELL level may use Gain; a BUY level may not.
    await page.getByTestId("add-level-SELL").click();
    const sellCard = page.getByTestId("level-card-SELL").first();
    await sellCard.getByTestId("metric-select").first().selectOption("GAIN:");
    await sellCard.getByTestId("value-control").first().fill("25");
    await expect(
      buyCard.getByTestId("metric-select").first().locator("option", { hasText: "Gain" }),
    ).toHaveCount(0);

    await expect(page.getByTestId("logic-preview")).toContainText(
      "Price is above EMA 200D",
    );
    await expectNoHorizontalScroll(page);

    await page.getByTestId("save-strategy").click();
    await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
    const url = page.url();

    // Persistence survives a reload.
    await page.reload();
    await expect(page.getByLabel("Name")).toHaveValue(STRATEGY_NAME);
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Margin of Safety (DCF (FCFF)) is above 25%",
    );
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Gain is above 25%",
    );

    // Editing an existing strategy: add a trigger and save again.
    await page.getByTestId("level-card-BUY").first().getByTestId("add-trigger").click();
    await page.getByTestId("save-strategy").click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("logic-preview")).toContainText("(trigger)");

    // Rename from the collection, then delete.
    await page.goto("/strategies");
    await card(page, STRATEGY_NAME).getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Name").fill(RENAMED);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(card(page, RENAMED)).toHaveCount(1);

    await card(page, RENAMED).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(card(page, RENAMED)).toHaveCount(0);

    // The deleted strategy's own page is a product state, not an error.
    await page.goto(url);
    await expect(page.getByTestId("strategy-not-found")).toBeVisible();
  });

  test("reports an invalid strategy on the rows that caused it", async ({ page }) => {
    await page.goto("/strategies/new");
    await page.getByLabel("Name").fill(STRATEGY_NAME);
    await page.getByTestId("add-level-BUY").click();
    // Two identical conditions: ANDing a predicate with itself is always a mistake.
    await page.getByTestId("add-condition").click();

    await expect(page.getByTestId("save-strategy")).toBeDisabled();
    await page.getByTestId("issue-count").click();
    await expect(page.getByText(/repeats condition 1/)).toBeVisible();
    // Rejected, never silently removed.
    await expect(page.getByTestId("predicate-row")).toHaveCount(2);
  });
});

test.describe("strategy builder on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.afterEach(async ({ page }) => {
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
  });

  test("creates and edits a strategy in one column, without sideways scrolling", async ({
    page,
  }) => {
    await page.goto("/strategies/new");
    await expectNoHorizontalScroll(page);

    await page.getByLabel("Name").fill(STRATEGY_NAME);
    await page.getByTestId("add-level-BUY").click();

    const buyCard = page.getByTestId("level-card-BUY").first();
    await buyCard.getByTestId("metric-select").first().selectOption("OSCILLATOR:RSI_14D");
    await buyCard.getByTestId("operator-select").first().selectOption("IS_BELOW");
    await buyCard.getByTestId("value-control").first().fill("30");

    // The percentage is a segmented control, tapped on its label like a real user would.
    await buyCard.getByTestId("level-percentage").getByText("50%").click();
    await expect(buyCard.getByRole("radio", { name: "50%" })).toBeChecked();

    // Contextual help moves next to the row being edited rather than into a side column.
    await buyCard.getByTestId("metric-select").first().click();
    await expect(page.getByTestId("inline-help")).toBeVisible();
    await expect(page.getByTestId("inline-help")).toContainText(
      "Relative Strength Index",
    );
    // Longer help sits behind a tap so it cannot bury the rest of the level on a phone.
    await page.getByTestId("inline-help").getByText("Formula and examples").click();
    await expect(page.getByTestId("inline-help")).toContainText(
      "warming up",
    );

    await expectNoHorizontalScroll(page);

    // The save surface is reachable and clear of the bottom navigation.
    const save = page.getByTestId("save-strategy");
    await expect(save).toBeEnabled();
    const saveBox = await save.boundingBox();
    const navBox = await page.getByRole("navigation", { name: "Primary mobile" }).boundingBox();
    if (navBox && saveBox) {
      expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(navBox.y + 1);
    }

    await save.click();
    await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);

    await page.reload();
    await expect(page.getByLabel("Name")).toHaveValue(STRATEGY_NAME);
    await expect(page.getByTestId("logic-preview")).toContainText(
      "RSI 14D is below 30",
    );
    await expectNoHorizontalScroll(page);
  });
});
