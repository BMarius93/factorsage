import { expect, test, type Page } from "@playwright/test";

/**
 * Full monitor journey for QA_USER against an already-running stack.
 *
 * The only precondition beyond the running stack is `pnpm test:users:seed`. Unlike the backtest
 * suite this one needs neither hydrated price history nor a running worker: creating, enabling,
 * disabling, renaming and deleting a monitor is user-owned configuration, and the scan cycle that
 * consumes it is proven in `apps/worker/src/monitor`. The suite provisions its own strategy and
 * stock list and removes both afterwards, so it depends on no pre-existing user-owned state.
 *
 * Its list is deliberately empty: a monitor's universe is whatever its list holds at the start of
 * each scan, and nothing here depends on a security existing.
 */

const STRATEGY_NAME = "E2E monitor strategy";
const LIST_NAME = "E2E monitor list";
/**
 * A monitor card names the monitor, its strategy and its list, and cards are located by contained
 * text — so these four names are kept pairwise non-overlapping. A monitor called "E2E monitor"
 * would be "found" by the text of its own strategy ("E2E monitor strategy"), and a rename to a
 * superstring of the original could not be told from a no-op.
 */
const MONITOR_NAME = "E2E watch alpha";
const RENAMED_MONITOR = "E2E watch beta";

function navLink(page: Page, label: string) {
  return page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: label });
}

function monitorCard(page: Page, name: string) {
  return page
    .getByTestId("monitors-grid")
    .locator("li")
    .filter({ hasText: name });
}

/** No page may scroll sideways: the collection must be readable on a phone without panning. */
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

async function createStrategy(page: Page, name: string) {
  await page.goto("/strategies/new");
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("add-level-BUY").click();
  const buyCard = page.getByTestId("level-card-BUY").first();
  await buyCard.getByTestId("metric-select").first().selectOption("PRICE:");
  await buyCard.getByTestId("operator-select").first().selectOption("IS_BELOW");
  await buyCard.getByTestId("value-control").first().selectOption("EMA_200D");
  await page.getByTestId("save-strategy").click();
  await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
    timeout: 20_000,
  });
}

/** An empty list is enough: this suite exercises monitor configuration, not evaluation. */
async function createList(page: Page, name: string) {
  await page.goto("/lists");
  await page.getByTestId("new-list-button").first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("list-detail")).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Best-effort teardown, monitors first.
 *
 * The order matters and is the product rule: a strategy or list a monitor still references cannot
 * be deleted, so removing the monitor is what unblocks the rest.
 */
async function deleteMonitorsIfPresent(page: Page, names: readonly string[]) {
  try {
    await page.goto("/monitors");
    await expect(
      page.getByTestId("monitors-grid").or(page.getByTestId("monitors-empty")),
    ).toBeVisible({ timeout: 20_000 });
    for (const name of names) {
      const card = monitorCard(page, name);
      if ((await card.count()) === 0) {
        continue;
      }
      await card.first().getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete monitor" }).click();
      await expect(card).toHaveCount(0);
    }
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

async function deleteStrategyIfPresent(page: Page, name: string) {
  try {
    await page.goto("/strategies");
    await expect(
      page
        .getByTestId("strategies-grid")
        .or(page.getByTestId("strategies-empty")),
    ).toBeVisible();
    const card = page
      .getByTestId("strategies-grid")
      .locator("li")
      .filter({ hasText: name });
    if ((await card.count()) === 0) {
      return;
    }
    await card.first().getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(card).toHaveCount(0);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

async function deleteListIfPresent(page: Page, name: string) {
  try {
    await page.goto("/lists");
    await expect(
      page.getByTestId("lists-grid").or(page.getByTestId("lists-empty")),
    ).toBeVisible();
    const card = page
      .getByTestId("lists-grid")
      .locator("li")
      .filter({ hasText: name });
    if ((await card.count()) === 0) {
      return;
    }
    await card.first().getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete list" }).click();
    await expect(card).toHaveCount(0);
  } catch {
    // Teardown must never replace the test's real failure with its own.
  }
}

/**
 * The per-test budget covers the hooks too, and this suite's `beforeEach` provisions a strategy
 * through the Builder and a stock list through the Lists UI — five sequential journeys against a
 * dev server that compiles each route on its first request. The default 30s is not enough for the
 * hooks plus the journey itself.
 */
const SUITE_TIMEOUT_MS = 180_000;

test.describe("QA_USER monitors", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    await deleteMonitorsIfPresent(page, [MONITOR_NAME, RENAMED_MONITOR]);
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
    await deleteListIfPresent(page, LIST_NAME);
    await createStrategy(page, STRATEGY_NAME);
    await createList(page, LIST_NAME);
  });

  test.afterEach(async ({ page }) => {
    await deleteMonitorsIfPresent(page, [MONITOR_NAME, RENAMED_MONITOR]);
    await deleteStrategyIfPresent(page, STRATEGY_NAME);
    await deleteListIfPresent(page, LIST_NAME);
  });

  test("creates a monitor, disables and re-enables it across reloads, renames it, and deletes it", async ({
    page,
  }) => {
    // 1. Create the monitor from the collection's call to action.
    await navLink(page, "Monitors").click();
    await expect(page).toHaveURL(/\/monitors$/);
    await expect(page.getByTestId("monitors-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("create-monitor-dialog");
    await expect(dialog).toBeVisible();
    // The pickers appear only once the caller's own strategies and lists have arrived.
    await expect(page.getByTestId("create-monitor-form")).toBeVisible({
      timeout: 20_000,
    });

    await dialog.getByLabel("Name", { exact: true }).fill(MONITOR_NAME);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: STRATEGY_NAME });
    await page.getByTestId("monitor-list").selectOption({ label: LIST_NAME });
    await page.getByTestId("submit-monitor").click();

    // 2. It appears in the collection, enabled, naming what it watches.
    await expect(dialog).toBeHidden();
    const card = monitorCard(page, MONITOR_NAME);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(STRATEGY_NAME);
    await expect(card).toContainText(LIST_NAME);
    await expect(card).toContainText("Enabled");
    await expect(card).toContainText("Not checked yet");

    // 3. Disable it, and prove the change is durable rather than local state.
    await card.getByTestId("toggle-monitor").click();
    await expect(card).toContainText("Disabled");
    await page.reload();
    const afterDisable = monitorCard(page, MONITOR_NAME);
    await expect(afterDisable).toContainText("Disabled", { timeout: 20_000 });
    await expect(afterDisable.getByTestId("toggle-monitor")).toHaveText(
      "Enable",
    );

    // 4. Re-enable it; that too survives a reload.
    await afterDisable.getByTestId("toggle-monitor").click();
    await expect(afterDisable).toContainText("Enabled");
    await page.reload();
    await expect(monitorCard(page, MONITOR_NAME)).toContainText("Enabled", {
      timeout: 20_000,
    });

    // 5. The strategy it watches cannot be deleted while it exists — and the refusal says so
    //    instead of looking like a transient failure.
    await navLink(page, "Strategies").click();
    const strategyCard = page
      .getByTestId("strategies-grid")
      .locator("li")
      .filter({ hasText: STRATEGY_NAME });
    await expect(strategyCard).toHaveCount(1);
    await strategyCard.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(
      "Delete the monitor first",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(strategyCard).toHaveCount(1);

    // 6. Rename the monitor; its strategy and list are unchanged.
    await navLink(page, "Monitors").click();
    await expect(page.getByTestId("monitors-grid")).toBeVisible({
      timeout: 20_000,
    });
    await monitorCard(page, MONITOR_NAME)
      .getByRole("button", { name: "Rename" })
      .click();
    const renameDialog = page.getByTestId("monitor-rename-dialog");
    await renameDialog.getByLabel("Name", { exact: true }).fill(RENAMED_MONITOR);
    await page.getByRole("button", { name: "Save changes" }).click();
    const renamed = monitorCard(page, RENAMED_MONITOR);
    await expect(renamed).toHaveCount(1);
    await expect(renamed).toContainText(STRATEGY_NAME);
    await expect(renamed).toContainText(LIST_NAME);
    await expect(monitorCard(page, MONITOR_NAME)).toHaveCount(0);

    // 7. The collection is usable on a phone.
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(renamed).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 8. Delete it after confirmation; the collection is empty again.
    await renamed.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete monitor" }).click();
    await expect(monitorCard(page, RENAMED_MONITOR)).toHaveCount(0);
  });

  test("explains what is missing instead of offering an empty picker", async ({
    page,
  }) => {
    // The persona owns the suite's strategy and list here, so the satisfied path is what the
    // dialog must show: both pickers populated, and no prerequisite notice.
    await page.goto("/monitors");
    await expect(page.getByTestId("monitors-page")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("new-monitor-button").first().click();
    await expect(page.getByTestId("create-monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("monitor-prerequisites")).toHaveCount(0);

    // Submitting with nothing chosen names every missing field rather than sending a request.
    await page.getByTestId("submit-monitor").click();
    await expect(page.getByText("A monitor needs a name.")).toBeVisible();
    await expect(page.getByText("Choose a strategy.")).toBeVisible();
    await expect(page.getByText("Choose a stock list.")).toBeVisible();
    await expect(page.getByTestId("create-monitor-dialog")).toBeVisible();
  });
});
