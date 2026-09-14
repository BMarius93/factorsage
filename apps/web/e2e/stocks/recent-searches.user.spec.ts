import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * RECENT SEARCHES in the global topbar search, for PRO_USER, through the real
 * Next + Nest + PostgreSQL stack.
 *
 * Preconditions are the Stock Details ones: `pnpm test:users:seed` once, and
 * `pnpm test:securities:seed` shortly before the run, so `QATEST1` exists with deterministic
 * history and the loader stays off any market-data provider.
 *
 * The persona is a persistent shared account whose recents survive between runs, so every
 * assertion here is about what viewing a stock *does* to the dropdown — the section appearing, the
 * viewed stock leading it, appearing once — never about the account starting empty.
 */

const QA_SYMBOL = "QATEST1";

const DESKTOP = { width: 1440, height: 900 };

function globalSearch(page: Page): Locator {
  return page.getByRole("combobox", { name: "Search stocks" });
}

function dropdown(page: Page): Locator {
  return page.getByRole("listbox");
}

async function openStockDetails(page: Page, symbol: string): Promise<void> {
  await page.goto(`/stocks/${symbol}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(symbol) }),
  ).toBeVisible();
}

/** Opens the dropdown on an empty query and waits for its shortcut sections. */
async function openShortcuts(page: Page): Promise<void> {
  await globalSearch(page).click();
  await expect(page.getByText("Recent Searches")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP);
});

test("a stock opened by URL becomes the first recent search @smoke", async ({
  page,
}) => {
  // Deliberately not reached through search: a pasted URL is one of the non-search routes into
  // Stock Details, and it must record the view exactly like a search selection does.
  await openStockDetails(page, QA_SYMBOL);

  await page.goto("/dashboard");
  await openShortcuts(page);

  const options = dropdown(page).getByRole("option");
  await expect(options.first()).toContainText(QA_SYMBOL);
  // Recents sit above the popular shortcuts, which are still there below them.
  await expect(page.getByText("Popular Searches")).toBeVisible();
});

test("a recent row navigates exactly like any other search row", async ({
  page,
}) => {
  await openStockDetails(page, QA_SYMBOL);
  await page.goto("/dashboard");

  await openShortcuts(page);
  await dropdown(page).getByRole("option").first().click();

  await expect(page).toHaveURL(new RegExp(`/stocks/${QA_SYMBOL}$`));
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(QA_SYMBOL) }),
  ).toBeVisible();
});

test("the same stock is never listed twice in the dropdown", async ({
  page,
}) => {
  await openStockDetails(page, QA_SYMBOL);
  // Viewing it again must promote the existing entry, never add a second one.
  await page.goto("/dashboard");
  await openStockDetails(page, QA_SYMBOL);
  await page.goto("/dashboard");

  await openShortcuts(page);

  await expect(
    dropdown(page).getByRole("option", { name: new RegExp(QA_SYMBOL) }),
  ).toHaveCount(1);
});

test("typing hides both shortcut sections and clearing the query brings them back", async ({
  page,
}) => {
  await openStockDetails(page, QA_SYMBOL);
  await page.goto("/dashboard");
  await openShortcuts(page);

  await globalSearch(page).fill(QA_SYMBOL.slice(0, 4));

  await expect(page.getByText("Results")).toBeVisible();
  await expect(page.getByText("Recent Searches")).toBeHidden();
  await expect(page.getByText("Popular Searches")).toBeHidden();

  await page.getByRole("button", { name: "Clear search" }).click();

  await expect(page.getByText("Recent Searches")).toBeVisible();
  await expect(page.getByText("Popular Searches")).toBeVisible();
});
