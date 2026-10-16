import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Builder's "Run backtest" action and the unsaved-changes guard, for PRO_USER.
 *
 * Every navigation out of a dirty Builder asks first — the top bar, the bottom bar, the account menu,
 * the back link — because leaving discards the draft and a backtest always runs the **saved**
 * version. Pre-release audit 2026-10-16, finding UI-03
 * (`docs/audits/pre-release-audit-2026-10-16.md`): the header's "Run backtest" link
 * (`StrategyBuilder.tsx` → `AccountActionLink`) is the one exit that does not, so an edited threshold
 * is silently dropped and the run uses the old one.
 *
 * Written as the behaviour every other exit already has; marked `test.fail()` while the defect is
 * open, so it passes by failing and turns red once the link is guarded.
 */

function watchConfirms(page: Page): string[] {
  const prompts: string[] = [];
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "confirm") {
      await dialog.accept();
      return;
    }
    prompts.push(dialog.message());
    // Stay: the draft must survive a cancelled navigation.
    await dialog.dismiss();
  });
  return prompts;
}

test("asks before Run backtest leaves a Builder with unsaved edits", async ({
  page,
}) => {
  test.fail(
    true,
    "KNOWN DEFECT UI-03: Run backtest bypasses the unsaved-changes guard",
  );
  const prompts = watchConfirms(page);
  const name = `E2E run guard ${Date.now()}`;
  let strategyId: string | null = null;
  try {
    await page.goto("/strategies/new");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByTestId("add-level-BUY").click();
    await page.getByTestId("save-strategy").click();
    await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
    await expect(page.getByText("All changes saved")).toBeVisible();
    strategyId = new URL(page.url()).pathname.split("/").pop() ?? null;

    // Edit without saving, then take the header's Run backtest action.
    await page.getByLabel("Name", { exact: true }).fill(`${name} edited`);
    await page.getByTestId("strategy-run-backtest").click();

    expect(prompts).toHaveLength(1);
    await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `${name} edited`,
    );
  } finally {
    if (strategyId) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
        .catch(() => {});
    }
  }
});
