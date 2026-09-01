import { expect, test, type Page } from "@playwright/test";

/**
 * Full lists journey for QA_USER against the deterministic QA catalog rows.
 *
 * Precondition beyond the usual stack + `pnpm test:users:seed`: the fictional QA securities must
 * exist in the running stack's catalog — seed them once with `pnpm test:securities:seed`. The
 * suite never talks to FMP and never assumes real market symbols exist in the environment.
 */

const QA_SYMBOL_ONE = "QATEST1";
const QA_SYMBOL_TWO = "QATEST2";

function itemRow(page: Page, symbol: string) {
  return page
    .getByTestId("list-items")
    .locator("li")
    .filter({ hasText: symbol });
}

async function searchAndPick(page: Page, symbol: string) {
  const searchInput = page.getByRole("combobox", {
    name: "Search stocks to add to the new list",
  });
  await searchInput.fill(symbol);
  const option = page.getByRole("option").filter({ hasText: symbol });
  await expect(
    option,
    `The QA catalog rows are missing. Seed them once with: pnpm test:securities:seed`,
  ).toBeVisible();
  await option.click();
  // The pick becomes a chip.
  await expect(page.getByLabel(`Remove ${symbol}`)).toBeVisible();
}

/**
 * Best-effort teardown through the product UI.
 *
 * The passing journey deletes its own list, so this normally finds nothing. It exists so a failed
 * assertion partway through cannot leave the shared QA_USER persona accumulating test lists.
 */
async function deleteListIfPresent(page: Page, listName: string) {
  try {
    await page.goto("/lists");
    await expect(
      page.getByTestId("lists-grid").or(page.getByTestId("lists-empty")),
    ).toBeVisible();

    const card = page
      .getByTestId("lists-grid")
      .locator("li")
      .filter({ hasText: listName });
    if ((await card.count()) === 0) {
      return;
    }

    await card.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete list" }).click();
    await expect(card).toHaveCount(0);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

test.describe("QA_USER stock lists", () => {
  let listName = "";

  test.afterEach(async ({ page }) => {
    if (listName === "") {
      return;
    }
    await deleteListIfPresent(page, listName);
    listName = "";
  });

  test("creates, configures buy windows, prunes, and deletes a list", async ({
    page,
  }) => {
    listName = `QA Lists E2E ${Date.now()}`;

    // 1. Create a uniquely named list with two catalog securities picked through search.
    await page.goto("/lists");
    await page.getByTestId("new-list-button").first().click();
    await page.getByLabel("Name").fill(listName);
    await searchAndPick(page, QA_SYMBOL_ONE);
    await searchAndPick(page, QA_SYMBOL_TWO);
    await page.getByRole("button", { name: "Create list" }).click();

    // 2. Creation lands on the saved list; both members start with full eligibility.
    await expect(page.getByTestId("list-detail")).toBeVisible();
    await expect(page.getByRole("heading", { name: listName })).toBeVisible();
    await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText("Full history");
    await expect(itemRow(page, QA_SYMBOL_TWO)).toContainText("Full history");

    // 3. Restrict one stock to two custom windows, the second one open-ended.
    await itemRow(page, QA_SYMBOL_ONE)
      .getByRole("button", { name: "Buy windows" })
      .click();
    const editor = page.getByTestId("buy-window-editor");
    await editor.getByRole("radio", { name: /Custom windows/ }).click();
    await editor.getByLabel("Range 1 start date").fill("2020-01-01");
    await editor.getByLabel("Range 1 end date").fill("2020-12-31");
    await editor.getByRole("button", { name: "+ Add range" }).click();
    await editor.getByLabel("Range 2 start date").fill("2023-01-01");
    await editor.getByTestId("save-buy-windows").click();

    // 4. The saved representation is the canonical one the API answered with.
    await expect(editor).not.toBeVisible();
    await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText(
      "Custom · 2 windows",
    );

    // Reopening shows the persisted canonical ranges, including the open-ended one.
    await itemRow(page, QA_SYMBOL_ONE)
      .getByRole("button", { name: "Buy windows" })
      .click();
    await expect(page.getByLabel("Range 1 start date")).toHaveValue(
      "2020-01-01",
    );
    await expect(page.getByLabel("Range 1 end date")).toHaveValue("2020-12-31");
    await expect(page.getByLabel("Range 2 start date")).toHaveValue(
      "2023-01-01",
    );
    await expect(page.getByLabel("Range 2 end date")).toHaveValue("");

    // 5. Switch back to FULL; the custom configuration is gone.
    await page
      .getByTestId("buy-window-editor")
      .getByRole("radio", { name: /Full history/ })
      .click();
    await page.getByTestId("save-buy-windows").click();
    await expect(itemRow(page, QA_SYMBOL_ONE)).toContainText("Full history");

    // 6. Remove the second stock after confirmation.
    await page.getByLabel(`Remove ${QA_SYMBOL_TWO} from list`).click();
    await page.getByRole("button", { name: "Remove stock" }).click();
    await expect(itemRow(page, QA_SYMBOL_TWO)).toHaveCount(0);
    await expect(itemRow(page, QA_SYMBOL_ONE)).toBeVisible();

    // 7. Delete the list; the collection no longer shows it.
    await page.getByTestId("delete-list-button").click();
    await page.getByRole("button", { name: "Delete list" }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByText(listName)).toHaveCount(0);
  });
});
