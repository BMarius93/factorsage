import { expect, test, type Page } from "@playwright/test";

/**
 * Full monitor journey for PRO_USER against an already-running stack.
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

const STRATEGY_NAME = "E2E monitor strategy A";
const STRATEGY_NAME_B = "E2E monitor strategy B";
const LIST_NAME = "E2E monitor list A";
const LIST_NAME_B = "E2E monitor list B";
/** Disjoint from the other two names: cards are located by contained text. */
const LIST_NAME_SEEDED = "E2E monitor seeded universe";

/** The deterministic QA security. Present only after `pnpm test:securities:seed`. */
const QA_SYMBOL = "QATEST1";
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

/**
 * Creates a list, optionally holding the deterministic QA security.
 *
 * An empty list is enough for the configuration journey — it exercises what a Monitor references,
 * not what evaluation decides. A member is only needed by the evaluation-table case, which skips
 * itself when the QA catalog rows are absent rather than failing on an unseeded machine.
 */
async function createList(
  page: Page,
  name: string,
  options: { withQaSecurity?: boolean } = {},
): Promise<boolean> {
  await page.goto("/lists");
  await page.getByTestId("new-list-button").first().click();
  await page.getByLabel("Name").fill(name);
  let seeded = true;
  if (options.withQaSecurity) {
    await page
      .getByRole("combobox", { name: "Search stocks to add to the new list" })
      .fill(QA_SYMBOL);
    const option = page.getByRole("option").filter({ hasText: QA_SYMBOL });
    seeded = await option
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (seeded) {
      await option.first().click();
    }
  }
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("list-detail")).toBeVisible({
    timeout: 20_000,
  });
  return seeded;
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

test.describe("PRO_USER monitors", () => {
  async function cleanUp(page: Page) {
    // Monitors first: a Strategy or List a Monitor still references cannot be deleted.
    await deleteMonitorsIfPresent(page, [MONITOR_NAME, RENAMED_MONITOR]);
    for (const name of [STRATEGY_NAME, STRATEGY_NAME_B]) {
      await deleteStrategyIfPresent(page, name);
    }
    for (const name of [LIST_NAME, LIST_NAME_B, LIST_NAME_SEEDED]) {
      await deleteListIfPresent(page, name);
    }
  }

  test.beforeEach(async ({ page }) => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    await cleanUp(page);
    await createStrategy(page, STRATEGY_NAME);
    await createStrategy(page, STRATEGY_NAME_B);
    await createList(page, LIST_NAME);
    await createList(page, LIST_NAME_B);
  });

  test.afterEach(async ({ page }) => {
    await cleanUp(page);
  });

  test("creates a monitor, opens it, rebinds it, renames it, toggles it, and deletes it", async ({
    page,
  }) => {
    // 1. Create the monitor from the collection's call to action.
    await navLink(page, "Monitors").click();
    await expect(page).toHaveURL(/\/monitors$/);
    await expect(page.getByTestId("monitors-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("monitor-form-dialog");
    await expect(dialog).toBeVisible();
    // The pickers appear only once the caller's own strategies and lists have arrived.
    await expect(page.getByTestId("monitor-form")).toBeVisible({
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

    // 5. The name opens the monitor's own page, which reports the same configuration.
    await card.getByRole("link", { name: MONITOR_NAME }).click();
    await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]{36}$/);
    const detail = page.getByTestId("monitor-detail");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    const detailUrl = page.url();
    await expect(detail).toContainText(STRATEGY_NAME);
    await expect(detail).toContainText(LIST_NAME);
    // Never scanned by this point, and the page says so rather than borrowing a creation time.
    await expect(page.getByTestId("monitor-last-checked")).toHaveText(
      "Not checked yet",
    );

    // 6. Rebind it to the other strategy and the other list in one edit.
    await page.getByTestId("edit-monitor").click();
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    // The form arrives carrying what the monitor currently watches.
    await expect(page.getByTestId("monitor-strategy")).toHaveValue(/.+/);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: STRATEGY_NAME_B });
    await page.getByTestId("monitor-list").selectOption({ label: LIST_NAME_B });
    // The consequence is explained only once the selection has actually moved.
    await expect(page.getByTestId("monitor-rebind-note")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("monitor-form")).toBeHidden();

    // 7. A reload proves the rebind is durable, not local state.
    await page.reload();
    await expect(page.getByTestId("monitor-detail")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("monitor-detail")).toContainText(
      STRATEGY_NAME_B,
    );
    await expect(page.getByTestId("monitor-detail")).toContainText(LIST_NAME_B);
    await expect(page.getByTestId("monitor-detail")).not.toContainText(
      STRATEGY_NAME,
    );
    // The new configuration has not been checked, and still says so after the rebind.
    await expect(page.getByTestId("monitor-last-checked")).toHaveText(
      "Not checked yet",
    );

    // 8. Rename from the same form, and prove that too survives a reload.
    await page.getByTestId("edit-monitor").click();
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByTestId("monitor-form-dialog")
      .getByLabel("Name", { exact: true })
      .fill(RENAMED_MONITOR);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("monitor-form")).toBeHidden();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: RENAMED_MONITOR }),
    ).toBeVisible({ timeout: 20_000 });

    // 9. Disable and re-enable from the detail page; both survive a reload.
    await page.getByTestId("toggle-monitor").click();
    await expect(page.getByTestId("monitor-enabled-pill")).toHaveText(
      "Disabled",
    );
    await page.reload();
    await expect(page.getByTestId("monitor-enabled-pill")).toHaveText(
      "Disabled",
      { timeout: 20_000 },
    );
    await page.getByTestId("toggle-monitor").click();
    await expect(page.getByTestId("monitor-enabled-pill")).toHaveText("Enabled");
    await page.reload();
    await expect(page.getByTestId("monitor-enabled-pill")).toHaveText(
      "Enabled",
      { timeout: 20_000 },
    );

    // 10. The detail page is usable on a phone.
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("monitor-detail")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 11. The collection reflects every edit.
    await navLink(page, "Monitors").click();
    await expect(page.getByTestId("monitors-grid")).toBeVisible({
      timeout: 20_000,
    });
    const reboundCard = monitorCard(page, RENAMED_MONITOR);
    await expect(reboundCard).toHaveCount(1);
    await expect(reboundCard).toContainText(STRATEGY_NAME_B);
    await expect(reboundCard).toContainText(LIST_NAME_B);
    await expect(reboundCard).toContainText("Not checked yet");
    await expect(monitorCard(page, MONITOR_NAME)).toHaveCount(0);

    // 12. The strategy it now watches cannot be deleted while it exists — and the refusal says so
    //     instead of looking like a transient failure.
    await navLink(page, "Strategies").click();
    const strategyCard = page
      .getByTestId("strategies-grid")
      .locator("li")
      .filter({ hasText: STRATEGY_NAME_B });
    await expect(strategyCard).toHaveCount(1);
    await strategyCard.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete strategy" }).click();
    await expect(page.getByTestId("confirm-dialog")).toContainText(
      "Delete the monitor first",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(strategyCard).toHaveCount(1);

    // 13. Delete it from its own page, after confirmation. That returns to the collection, which
    //     no longer lists it — and the strategy it held is deletable again in teardown.
    await page.goto(detailUrl);
    await expect(page.getByTestId("monitor-detail")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("delete-monitor").click();
    await page.getByRole("button", { name: "Delete monitor" }).click();
    await expect(page).toHaveURL(/\/monitors$/);
    await expect(monitorCard(page, RENAMED_MONITOR)).toHaveCount(0);
  });

  test("reports every monitored stock as unchecked before the first scan", async ({
    page,
  }) => {
    // The evaluation table is a projection of durable worker state, so what a suite without a
    // worker can prove deterministically is the honest pre-scan state: a real member of the list,
    // reported as not checked rather than as a decided non-match. The other three statuses are
    // pinned against real persisted rows in `monitors.integration.test.ts`, and against the
    // contract payloads in `MonitorDetail.test.tsx`.
    const seeded = await createList(page, LIST_NAME_SEEDED, {
      withQaSecurity: true,
    });
    test.skip(
      !seeded,
      `${QA_SYMBOL} is not in the catalog. Run \`pnpm test:securities:seed\` against the stack ` +
        "this suite drives.",
    );

    await page.goto("/monitors");
    await expect(page.getByTestId("monitors-page")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("new-monitor-button").first().click();
    const dialog = page.getByTestId("monitor-form-dialog");
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await dialog.getByLabel("Name", { exact: true }).fill(MONITOR_NAME);
    await page
      .getByTestId("monitor-strategy")
      .selectOption({ label: STRATEGY_NAME });
    await page
      .getByTestId("monitor-list")
      .selectOption({ label: LIST_NAME_SEEDED });
    await page.getByTestId("submit-monitor").click();
    await expect(dialog).toBeHidden();

    await monitorCard(page, MONITOR_NAME)
      .getByRole("link", { name: MONITOR_NAME })
      .click();
    await expect(page.getByTestId("monitor-detail")).toBeVisible({
      timeout: 20_000,
    });

    const row = page.getByTestId("monitor-security-row").filter({
      hasText: QA_SYMBOL,
    });
    await expect(row).toHaveCount(1);
    // Never evaluated is never "No match".
    await expect(row.getByTestId("monitor-security-status")).toHaveText(
      "Not checked yet",
    );
    await expect(page.getByTestId("monitor-signals-empty")).toBeVisible();
    await expect(page.getByTestId("monitor-last-checked")).toHaveText(
      "Not checked yet",
    );

    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await deleteMonitorsIfPresent(page, [MONITOR_NAME]);
    await deleteListIfPresent(page, LIST_NAME_SEEDED);
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
    await expect(page.getByTestId("monitor-form")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("monitor-prerequisites")).toHaveCount(0);

    // Submitting with nothing chosen names every missing field rather than sending a request.
    await page.getByTestId("submit-monitor").click();
    await expect(page.getByText("A monitor needs a name.")).toBeVisible();
    await expect(page.getByText("Choose a strategy.")).toBeVisible();
    await expect(page.getByText("Choose a stock list.")).toBeVisible();
    await expect(page.getByTestId("monitor-form-dialog")).toBeVisible();
  });
});
