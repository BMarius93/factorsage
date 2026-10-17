import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Builder's "Run backtest" action and the unsaved-changes guard, for PRO_USER.
 *
 * Every navigation out of a dirty Builder asks first — the top bar, the bottom bar, the account menu,
 * the back link — because leaving discards the draft and a backtest always runs the **saved**
 * version. Pre-release audit 2026-10-16, finding UI-03
 * (`docs/audits/pre-release-audit-2026-10-16.md`): the header's "Run backtest" link
 * (`StrategyBuilder.tsx` → `AccountActionLink`) was the one exit that did not, so an edited
 * threshold was silently dropped and the run used the old one. It now asks like every other exit.
 */

function watchConfirms(
  page: Page,
  answer: "stay" | "leave" = "stay",
): string[] {
  const prompts: string[] = [];
  page.on("dialog", async (dialog) => {
    if (dialog.type() !== "confirm") {
      await dialog.accept();
      return;
    }
    prompts.push(dialog.message());
    if (answer === "leave") {
      await dialog.accept();
    } else {
      // Stay: the draft must survive a cancelled navigation.
      await dialog.dismiss();
    }
  });
  return prompts;
}

async function savedStrategy(page: Page, name: string): Promise<string> {
  await page.goto("/strategies/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByTestId("add-level-BUY").click();
  await page.getByTestId("save-strategy").click();
  await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
  await expect(page.getByText("All changes saved")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

test("goes straight to the prefilled form from a Builder with nothing unsaved", async ({
  page,
}) => {
  const prompts = watchConfirms(page);
  let strategyId: string | null = null;
  try {
    strategyId = await savedStrategy(page, `E2E run clean ${Date.now()}`);
    await page.getByTestId("strategy-run-backtest").click();
    await expect(page).toHaveURL(
      new RegExp(`/backtests/new\\?.*strategyId=${strategyId}`),
    );
    expect(prompts).toEqual([]);
  } finally {
    if (strategyId) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
        .catch(() => {});
    }
  }
});

test("leaves for the saved version only when the user agrees to discard the edits", async ({
  page,
}) => {
  const prompts = watchConfirms(page, "leave");
  let strategyId: string | null = null;
  try {
    const name = `E2E run discard ${Date.now()}`;
    strategyId = await savedStrategy(page, name);
    await page.getByLabel("Name", { exact: true }).fill(`${name} edited`);
    await page.getByTestId("strategy-run-backtest").click();
    expect(prompts).toHaveLength(1);
    await expect(page).toHaveURL(
      new RegExp(`/backtests/new\\?.*strategyId=${strategyId}`),
    );
  } finally {
    if (strategyId) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
        .catch(() => {});
    }
  }
});

test("asks before Run backtest leaves a Builder with unsaved edits", async ({
  page,
}) => {
  const prompts = watchConfirms(page);
  const name = `E2E run guard ${Date.now()}`;
  let strategyId: string | null = null;
  try {
    strategyId = await savedStrategy(page, name);

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
