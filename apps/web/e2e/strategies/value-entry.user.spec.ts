import { expect, test, type Locator, type Page } from "../fixtures";
import { chooseMetric } from "../utils/strategy-builder";

/**
 * Typing a Value the way a person does — one key at a time — in the Strategy Builder, for PRO_USER.
 *
 * Every other Builder spec sets a Value with `fill()`, which writes the whole string in one event and
 * so never passes through the partial entries a number input reports as empty (`-`, `0.`). Pre-release
 * audit 2026-10-16, finding UI-01 (`docs/audits/pre-release-audit-2026-10-16.md`): `ValueControl`
 * turns that empty report into `NaN`, writes `"NaN"` back into the field, and the browser clears it —
 * so `0.75` typed key by key becomes `75`, and `-1.5` becomes `5`.
 *
 * Written as the behaviour the product promises. Both cases are marked `test.fail()` while the
 * defect is open: they pass by failing, and turn red the moment `ValueControl` keeps what was typed,
 * at which point the annotation is removed. Needs no securities and no market data.
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
    test.fail(
      true,
      "KNOWN DEFECT UI-01: a decimal typed key by key is corrupted",
    );
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
    test.fail(
      true,
      "KNOWN DEFECT UI-01: a negative typed key by key loses its sign",
    );
    const row = await startRow(page);
    await chooseMetric(
      row,
      "FUNDAMENTALS",
      "FUNDAMENTAL:NET_DEBT_TO_EBITDA_TTM",
    );
    await row.getByTestId("operator-select").selectOption("IS_BELOW");
    await typeValue(row, "-1.5");
    await expect(row.getByTestId("value-control")).toHaveValue("-1.5");
  });
});
