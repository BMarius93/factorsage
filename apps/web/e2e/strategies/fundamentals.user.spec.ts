import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseMetric } from "../utils/strategy-builder";

/**
 * Fundamental Metrics in the Strategy Builder, for PRO_USER, against the real API.
 *
 * What only a browser can prove: that a Fundamental Condition authored through the two metric
 * selectors is saved as its stable identity, and reads back after a reload exactly as it was
 * written — in every control, in the Strategy Logic and in the explanation — and that a Trigger row
 * never offers the category at all.
 *
 * Needs no securities and no market data: a strategy references only the static catalogs.
 */

function strategyIdOf(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

async function readStrategy(
  page: Page,
  strategyId: string,
): Promise<StrategyDetailResponse> {
  const response = await page.request.get(
    `${apiBaseUrl()}/strategies/${strategyId}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as StrategyDetailResponse;
}

async function deleteStrategies(page: Page, ids: readonly (string | null)[]) {
  for (const id of ids) {
    if (id) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${id}`)
        .catch(() => {});
    }
  }
}

function buyRows(page: Page): Locator {
  return page
    .getByTestId("level-card-BUY")
    .first()
    .getByTestId("predicate-row");
}

async function startStrategy(page: Page, name: string): Promise<Locator> {
  await page.goto("/strategies/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByTestId("add-level-BUY").click();
  return buyRows(page).first();
}

/** Every control of one row, asserted against what the rule should read. */
async function expectRow(
  row: Locator,
  expected: {
    metric: { value: string; label: string };
    operator: string;
    value: string;
    unit: string;
  },
): Promise<void> {
  const category = row.getByTestId("metric-category-select");
  await expect(category).toHaveValue("FUNDAMENTALS");
  await expect(category.locator("option:checked")).toHaveText("Fundamentals");
  const metric = row.getByTestId("metric-select");
  await expect(metric).toHaveValue(expected.metric.value);
  await expect(metric.locator("option:checked")).toHaveText(
    expected.metric.label,
  );
  await expect(row.getByTestId("operator-select")).toHaveValue(
    expected.operator,
  );
  await expect(row.getByTestId("value-control")).toHaveValue(expected.value);
  await expect(row.getByText(expected.unit, { exact: true })).toBeVisible();
  // No configuration: the metric is the whole identity of the rule.
  await expect(row.getByTestId("operand-config-button")).toHaveCount(0);
}

test.describe("Fundamental Metrics in the Strategy Builder", () => {
  test("A: ROIC TTM above 15% and Debt / Equity below 1x save as identities and reopen exactly", async ({
    page,
  }) => {
    const name = `E2E fundamentals ${Date.now()}`;
    let id: string | null = null;
    try {
      const roic = await startStrategy(page, name);
      await chooseMetric(roic, "FUNDAMENTALS", "FUNDAMENTAL:ROIC_TTM");
      // Strict comparisons only.
      await expect(
        roic.getByTestId("operator-select").locator("option"),
      ).toHaveText(["is above", "is below"]);
      await roic.getByTestId("operator-select").selectOption("IS_ABOVE");
      await roic.getByTestId("value-control").fill("15");

      await page
        .getByTestId("level-card-BUY")
        .first()
        .getByTestId("add-condition")
        .click();
      const leverage = buyRows(page).nth(1);
      await chooseMetric(
        leverage,
        "FUNDAMENTALS",
        "FUNDAMENTAL:DEBT_TO_EQUITY",
      );
      await leverage.getByTestId("operator-select").selectOption("IS_BELOW");
      await leverage.getByTestId("value-control").fill("1");

      const reads = async () => {
        await expectRow(buyRows(page).first(), {
          metric: { value: "FUNDAMENTAL:ROIC_TTM", label: "ROIC TTM" },
          operator: "IS_ABOVE",
          value: "15",
          unit: "%",
        });
        await expectRow(buyRows(page).nth(1), {
          metric: {
            value: "FUNDAMENTAL:DEBT_TO_EQUITY",
            label: "Debt / Equity",
          },
          operator: "IS_BELOW",
          value: "1",
          unit: "x",
        });
        const preview = page.getByTestId("logic-preview");
        await expect(preview).toContainText("ROIC TTM is above 15%");
        await expect(preview).toContainText("Debt / Equity is below 1.0x");

        // The explanation follows the metric in hand, from the catalog.
        await buyRows(page).first().getByTestId("metric-select").focus();
        const panel = page.getByTestId("explanation-panel");
        await expect(panel.getByRole("heading")).toHaveText("ROIC TTM");
        await expect(panel.getByTestId("help-category")).toHaveText(
          "Fundamentals",
        );
        await expect(panel.getByTestId("help-notes")).toContainText(
          "percentage points",
        );
      };
      await reads();

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);

      // Persisted as the stable identities, with the thresholds as typed.
      const saved = await readStrategy(page, id);
      const conditions = saved.definition.buyLevels[0]?.signal.conditions ?? [];
      expect(
        conditions.map(({ metric, operator, value }) => ({
          metric,
          operator,
          value,
        })),
      ).toEqual([
        {
          metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
          operator: "IS_ABOVE",
          value: { kind: "PERCENT", value: 15 },
        },
        {
          metric: { kind: "FUNDAMENTAL", metricId: "DEBT_TO_EQUITY" },
          operator: "IS_BELOW",
          value: { kind: "MULTIPLE", value: 1 },
        },
      ]);

      // Reopened, the same rules read the same everywhere.
      await page.reload();
      await reads();
      await expect(page.getByTestId("save-strategy")).toBeDisabled();

      // Edit one threshold of the saved strategy: a new version, the other rule untouched.
      await buyRows(page).nth(1).getByTestId("value-control").fill("0.75");
      await expect(page.getByTestId("logic-preview")).toContainText(
        "Debt / Equity is below 0.75x",
      );
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      const edited = await readStrategy(page, id);
      expect(edited.versionNumber).toBe(2);
      expect(edited.definition.buyLevels[0]?.signal.conditions[0]).toEqual(
        conditions[0],
      );
      expect(
        edited.definition.buyLevels[0]?.signal.conditions[1]?.value,
      ).toEqual({
        kind: "MULTIPLE",
        value: 0.75,
      });
    } finally {
      await deleteStrategies(page, [id]);
    }
  });

  test("B: a Trigger row never offers Fundamentals, and switching units starts the Value over", async ({
    page,
  }) => {
    const row = await startStrategy(
      page,
      `E2E fundamentals trigger ${Date.now()}`,
    );
    await chooseMetric(row, "FUNDAMENTALS", "FUNDAMENTAL:ROIC_TTM");
    await row.getByTestId("value-control").fill("15");
    // A ratio cannot keep a percentage: the Value starts over at its own neutral 1x.
    await row
      .getByTestId("metric-select")
      .selectOption("FUNDAMENTAL:CURRENT_RATIO");
    await expect(row.getByTestId("value-control")).toHaveValue("1");
    await expect(row.getByText("x", { exact: true })).toBeVisible();

    await page
      .getByTestId("level-card-BUY")
      .first()
      .getByTestId("add-trigger")
      .click();
    const trigger = buyRows(page).last();
    await expect(
      trigger.getByTestId("metric-category-select").locator("option"),
    ).toHaveText(["Price", "Moving averages", "Oscillators", "Valuation"]);
    await expect(
      trigger.getByTestId("operator-select").locator("option"),
    ).toHaveText(["crosses above", "crosses below"]);
  });
});

test.describe("Fundamental Metrics on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the longest Fundamental labels in one column, without sideways scrolling", async ({
    page,
  }) => {
    const row = await startStrategy(
      page,
      `E2E fundamentals phone ${Date.now()}`,
    );
    await chooseMetric(
      row,
      "FUNDAMENTALS",
      "FUNDAMENTAL:NET_DEBT_TO_EBITDA_TTM",
    );
    await expect(
      row.getByTestId("metric-select").locator("option:checked"),
    ).toHaveText("Net Debt / EBITDA TTM");
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Net Debt / EBITDA TTM is above 1.0x",
    );
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
