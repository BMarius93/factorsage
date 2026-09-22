import type {
  StrategyDefinition,
  StrategyDetailResponse,
} from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import {
  chooseFromOverflowMenu,
  overflowMenuActions,
} from "../utils/overflow-menu";

/**
 * Duplicating a strategy from the Strategies collection, for PRO_USER.
 *
 * A copy is a strategy of the customer's own with the source's logic — every level, condition,
 * trigger and exit rule, in order — under new identities, and the browser lands in the Builder for
 * it. The source, the customer's own or a built-in, is left exactly as it was.
 *
 * Needs the QA built-ins (`pnpm test:builtins:seed`, part of `pnpm test:personas:seed`); a strategy
 * otherwise touches no securities and no market data.
 */

const QA_BUILT_IN_STRATEGY = "QA Built-in Trend";

/**
 * Enough structure to prove a deep copy: two BUY levels (one with a trigger), two SELL levels, and
 * a FINAL EXIT reached by three exit rules.
 */
function richDefinition(): StrategyDefinition {
  return {
    schemaVersion: 2,
    buyLevels: [
      {
        id: "e2e-buy-1",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "e2e-buy-1-rsi",
              metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
              operator: "IS_BELOW",
              value: { kind: "NUMBER", value: 30 },
            },
          ],
          trigger: {
            id: "e2e-buy-1-cross",
            metric: { kind: "PRICE" },
            operator: "CROSSES_ABOVE",
            value: { kind: "SERIES", seriesId: "EMA_50D" },
          },
        },
      },
      {
        id: "e2e-buy-2",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "e2e-buy-2-margin",
              metric: { kind: "MARGIN_OF_SAFETY", sourceId: "DCF_FCFF" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 22.5 },
            },
          ],
        },
      },
    ],
    sellLevels: [
      {
        id: "e2e-sell-1",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "e2e-sell-1-gain",
              metric: { kind: "GAIN" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 25 },
            },
          ],
        },
      },
      {
        id: "e2e-sell-2",
        percentage: 25,
        signal: {
          conditions: [
            {
              id: "e2e-sell-2-trend",
              metric: { kind: "MOVING_AVERAGE", seriesId: "EMA_50D" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
    finalExit: {
      id: "e2e-exit",
      rules: [
        {
          id: "e2e-exit-loss",
          signal: {
            conditions: [],
            trigger: {
              id: "e2e-exit-loss-cross",
              metric: { kind: "LOSS" },
              operator: "CROSSES_ABOVE",
              value: { kind: "PERCENT", value: 10 },
            },
          },
        },
        {
          id: "e2e-exit-trend",
          signal: {
            conditions: [
              {
                id: "e2e-exit-trend-rsi",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 70 },
              },
            ],
          },
        },
        {
          id: "e2e-exit-profit",
          signal: {
            conditions: [
              {
                id: "e2e-exit-profit-gain",
                metric: { kind: "GAIN" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 50 },
              },
            ],
            trigger: {
              id: "e2e-exit-profit-cross",
              metric: { kind: "PRICE" },
              operator: "CROSSES_BELOW",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
          },
        },
      ],
    },
  };
}

/** Every `id` anywhere in a definition, found by walking it rather than by naming row kinds. */
function idsIn(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(idsIn);
  }
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) =>
      key === "id" && typeof value === "string" ? [value] : idsIn(value),
    );
  }
  return [];
}

function withoutIds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(withoutIds);
  }
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "id")
        .map(([key, value]) => [key, withoutIds(value)]),
    );
  }
  return node;
}

/** The copy holds the source's logic exactly, and not one of its identities. */
function expectSameLogicNewIdentity(
  copy: StrategyDefinition,
  source: StrategyDefinition,
) {
  expect(withoutIds(copy)).toEqual(withoutIds(source));
  const sourceIds = idsIn(source);
  const copyIds = idsIn(copy);
  expect(copyIds).toHaveLength(sourceIds.length);
  expect(copyIds.filter((id) => sourceIds.includes(id))).toEqual([]);
}

function collectionRow(page: Page, section: string, name: string): Locator {
  return page
    .getByTestId(section)
    .locator("tbody tr")
    .filter({ hasText: name });
}

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

/** Best-effort teardown, so a failure cannot leave PRO_USER accumulating strategies. */
async function deleteStrategyIfPresent(page: Page, strategyId: string | null) {
  if (strategyId === null) {
    return;
  }
  await page.request
    .delete(`${apiBaseUrl()}/strategies/${strategyId}`)
    .catch(() => {});
}

test.describe("PRO_USER duplicates strategies", () => {
  test("copies every level and exit rule of a strategy, then opens the copy in the Builder", async ({
    page,
  }) => {
    const sourceName = `E2E duplicate source ${Date.now()}`;
    const copyName = `${sourceName} (copy)`;
    let sourceId: string | null = null;
    let copyId: string | null = null;

    try {
      await page.goto("/strategies");
      const created = await page.request.post(`${apiBaseUrl()}/strategies`, {
        data: {
          name: sourceName,
          description: "Two buys, two sells, three ways out.",
          definition: richDefinition(),
        },
      });
      expect(
        created.ok(),
        `POST /strategies failed with ${created.status()}: ${await created.text()}`,
      ).toBe(true);
      const source = (await created.json()) as StrategyDetailResponse;
      sourceId = source.id;

      await page.reload();
      const row = collectionRow(page, "strategies-grid", sourceName);
      expect(await overflowMenuActions(page, sourceName, row)).toEqual([
        "Rename",
        "Duplicate",
        "Delete",
      ]);
      await page.keyboard.press("Escape");
      await chooseFromOverflowMenu(page, sourceName, "Duplicate", row);

      const dialog = page.getByTestId("duplicate-dialog");
      await expect(
        dialog.getByRole("heading", { name: "Duplicate strategy" }),
      ).toBeVisible();
      const name = dialog.getByLabel("Name");
      await expect(name).toHaveValue(`${sourceName} — Copy`);
      await name.fill(copyName);
      // Enter submits, as in every other form.
      await name.press("Enter");

      // Straight into the Builder for the copy, with nothing left to save.
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expect(page.getByTestId("strategy-builder")).toBeVisible();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        copyName,
      );
      await expect(page.getByTestId("level-card-BUY")).toHaveCount(2);
      await expect(page.getByTestId("level-card-SELL")).toHaveCount(2);
      const finalExit = page.getByTestId("level-card-FINAL_EXIT");
      await expect(finalExit).toHaveCount(1);
      await expect(finalExit.getByTestId("exit-rule")).toHaveCount(3);
      await expect(finalExit.getByTestId("exit-rule-or")).toHaveCount(2);

      const preview = page.getByTestId("logic-preview");
      for (const line of [
        "RSI 14D is below 30",
        "Price crosses above EMA 50D",
        "Margin of Safety · DCF (FCFF) is above 22.5%",
        "Gain is above 25%",
        "EMA 50D is below SMA 200D",
        "Exit rule 3",
        "Loss crosses above 10%",
        "RSI 14D is above 70",
        "Gain is above 50%",
        "Price crosses below EMA 50D",
      ]) {
        await expect(preview).toContainText(line);
      }
      await expect(page.getByTestId("save-strategy")).toBeDisabled();
      // The Builder offers no Duplicate: copying starts from the collection.
      await expect(
        page.getByRole("button", { name: "Duplicate", exact: true }),
      ).toHaveCount(0);

      // Same logic under new identities, as version 1 of its own; the source exactly as it was.
      const copy = await readStrategy(page, copyId);
      expect(copy).toMatchObject({
        ownership: "USER",
        canEdit: true,
        versionNumber: 1,
        description: "Two buys, two sells, three ways out.",
      });
      expectSameLogicNewIdentity(copy.definition, source.definition);
      expect(await readStrategy(page, sourceId)).toEqual(source);
    } finally {
      await deleteStrategyIfPresent(page, copyId);
      await deleteStrategyIfPresent(page, sourceId);
    }
  });

  test("copies a built-in strategy into an editable strategy of the customer's own", async ({
    page,
  }) => {
    let copyId: string | null = null;

    try {
      const collection = (await (
        await page.request.get(`${apiBaseUrl()}/strategies`)
      ).json()) as StrategyDetailResponse[];
      const listed = collection.find(
        (strategy) =>
          strategy.name === QA_BUILT_IN_STRATEGY &&
          strategy.ownership === "SYSTEM",
      );
      test.skip(
        listed === undefined,
        "The QA built-ins are missing. Run `pnpm test:builtins:seed`.",
      );
      const before = await readStrategy(
        page,
        (listed as StrategyDetailResponse).id,
      );

      await page.goto("/strategies");
      const row = collectionRow(
        page,
        "built-in-strategies",
        QA_BUILT_IN_STRATEGY,
      );
      expect(
        await overflowMenuActions(page, QA_BUILT_IN_STRATEGY, row),
      ).toEqual(["Duplicate"]);
      await page.keyboard.press("Escape");
      await chooseFromOverflowMenu(
        page,
        QA_BUILT_IN_STRATEGY,
        "Duplicate",
        row,
      );

      const dialog = page.getByTestId("duplicate-dialog");
      await expect(dialog.getByLabel("Name")).toHaveValue(
        `${QA_BUILT_IN_STRATEGY} — Copy`,
      );
      await dialog
        .getByRole("button", { name: "Duplicate", exact: true })
        .click();

      // The customer's own copy opens in the editable Builder, not the read-only view.
      await expect(page.getByTestId("strategy-builder")).toBeVisible({
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      await expect(page.getByTestId("strategy-read-only")).toHaveCount(0);
      await expect(page.getByTestId("built-in-badge")).toHaveCount(0);
      const preview = page.getByTestId("logic-preview");
      await expect(preview).toContainText("Price crosses above SMA 20D");
      await expect(preview).toContainText("Price crosses below SMA 200D");

      const copy = await readStrategy(page, copyId);
      expect(copy).toMatchObject({
        ownership: "USER",
        canEdit: true,
        versionNumber: 1,
      });
      expect(copy.systemKey).toBeUndefined();
      expectSameLogicNewIdentity(copy.definition, before.definition);

      // Editable: a renamed copy saves.
      const renamed = `${QA_BUILT_IN_STRATEGY} — Mine ${Date.now()}`;
      await page.getByLabel("Name", { exact: true }).fill(renamed);
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      expect((await readStrategy(page, copyId)).name).toBe(renamed);

      // The built-in is unchanged, and still read-only for this customer.
      const after = await readStrategy(page, before.id);
      expect(after).toEqual(before);
      expect(after).toMatchObject({ ownership: "SYSTEM", canEdit: false });
    } finally {
      await deleteStrategyIfPresent(page, copyId);
    }
  });
});
