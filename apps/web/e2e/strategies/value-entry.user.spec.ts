import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseMetric } from "../utils/strategy-builder";

/**
 * Typing a Value the way a person does — one key at a time — in the Strategy Builder, for PRO_USER.
 *
 * Every other Builder spec sets a Value with `fill()`, which writes the whole string in one event and
 * so never passes through the partial entries a number input reports as empty (`-`, `0.`, `-0.`).
 * Pre-release audit 2026-10-16, finding UI-01 (`docs/audits/pre-release-audit-2026-10-16.md`):
 * `ValueControl` turned that empty report into `NaN`, wrote `"NaN"` back into the field, and the
 * browser cleared it — so `0.75` typed key by key became `75`, and `-1.5` became `5`. The field now
 * keeps what was typed. Needs no securities and no market data.
 */

function buyRows(page: Page): Locator {
  return page
    .getByTestId("level-card-BUY")
    .first()
    .getByTestId("predicate-row");
}

async function startRow(page: Page): Promise<Locator> {
  await page.goto("/strategies/new");
  await page
    .getByLabel("Name", { exact: true })
    .fill(`E2E value entry ${Date.now()}`);
  await page.getByTestId("add-level-BUY").click();
  return buyRows(page).first();
}

async function typeValue(row: Locator, typed: string): Promise<void> {
  const field = row.getByTestId("value-control");
  await field.fill("");
  await field.pressSequentially(typed, { delay: 40 });
}

test.describe("typing a Value key by key", () => {
  test("keeps a decimal multiple: Debt / Equity is below 0.75x", async ({
    page,
  }) => {
    const row = await startRow(page);
    await chooseMetric(row, "FUNDAMENTALS", "FUNDAMENTAL:DEBT_TO_EQUITY");
    await row.getByTestId("operator-select").selectOption("IS_BELOW");
    await typeValue(row, "0.75");
    await expect(row.getByTestId("value-control")).toHaveValue("0.75");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Debt / Equity is below 0.75x",
    );
  });

  test("keeps a negative multiple: Net Debt / EBITDA is below -1.5x", async ({
    page,
  }) => {
    const row = await startRow(page);
    await chooseMetric(
      row,
      "FUNDAMENTALS",
      "FUNDAMENTAL:NET_DEBT_TO_EBITDA_TTM",
    );
    await row.getByTestId("operator-select").selectOption("IS_BELOW");
    await typeValue(row, "-1.5");
    await expect(row.getByTestId("value-control")).toHaveValue("-1.5");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Net Debt / EBITDA TTM is below -1.5x",
    );
  });

  test("keeps a negative fraction through `-`, `-0` and `-0.`: below -0.25x", async ({
    page,
  }) => {
    const row = await startRow(page);
    await chooseMetric(
      row,
      "FUNDAMENTALS",
      "FUNDAMENTAL:NET_DEBT_TO_EBITDA_TTM",
    );
    await row.getByTestId("operator-select").selectOption("IS_BELOW");
    await typeValue(row, "-0.25");
    await expect(row.getByTestId("value-control")).toHaveValue("-0.25");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Net Debt / EBITDA TTM is below -0.25x",
    );
  });

  test("keeps zero: Debt / Equity is above 0.0x", async ({ page }) => {
    const row = await startRow(page);
    await chooseMetric(row, "FUNDAMENTALS", "FUNDAMENTAL:DEBT_TO_EQUITY");
    await row.getByTestId("operator-select").selectOption("IS_ABOVE");
    await typeValue(row, "0");
    await expect(row.getByTestId("value-control")).toHaveValue("0");
    await expect(page.getByTestId("logic-preview")).toContainText(
      // The preview prints a multiple to one decimal; the field keeps what was typed.
      "Debt / Equity is above 0.0x",
    );
  });

  test("saves exactly what was typed, and shows it again after a reload", async ({
    page,
  }) => {
    const row = await startRow(page);
    await chooseMetric(row, "FUNDAMENTALS", "FUNDAMENTAL:DEBT_TO_EQUITY");
    await row.getByTestId("operator-select").selectOption("IS_BELOW");
    await typeValue(row, "0.75");
    await page.getByTestId("save-strategy").click();
    await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
    await expect(page.getByText("All changes saved")).toBeVisible();
    const strategyId = new URL(page.url()).pathname.split("/").pop() ?? "";
    try {
      // The canonical document holds the number, not the keystrokes.
      const stored = await page.request.get(
        `${apiBaseUrl()}/strategies/${strategyId}`,
      );
      expect(JSON.stringify(await stored.json())).toContain('"value":0.75');

      await page.reload();
      await expect(
        buyRows(page).first().getByTestId("value-control"),
      ).toHaveValue("0.75");
      await expect(page.getByTestId("logic-preview")).toContainText(
        "Debt / Equity is below 0.75x",
      );
    } finally {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
        .catch(() => {});
    }
  });
});
