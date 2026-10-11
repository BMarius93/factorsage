import type { StrategyDetailResponse } from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { chooseFromOverflowMenu } from "../utils/overflow-menu";
import {
  categoryLabels,
  chooseMetric,
  openPicker,
  showCategory,
} from "../utils/strategy-builder";

/**
 * The Metric (category -> metric, in one picker) -> Configuration -> Condition -> Value row, for
 * PRO_USER.
 *
 * What only a browser against the real API can prove: that a configurable metric's identity and its
 * configuration read the same on every surface — the Metric picker, the row's summary, the Configure
 * dialog, the Strategy Logic panel and the explanation panel — and that saving, reloading, editing
 * and duplicating the strategy changes none of it. The selector once read `Insider sellers 20D`
 * while the rest of the page said `180D`.
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

/** Best-effort teardown, so a failure cannot leave PRO_USER accumulating strategies. */
async function deleteStrategies(page: Page, ids: readonly (string | null)[]) {
  for (const id of ids) {
    if (id) {
      await page.request
        .delete(`${apiBaseUrl()}/strategies/${id}`)
        .catch(() => {});
    }
  }
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

function firstRow(page: Page): Locator {
  return page
    .getByTestId("level-card-BUY")
    .first()
    .getByTestId("predicate-row")
    .first();
}

async function startStrategy(page: Page, name: string): Promise<Locator> {
  await page.goto("/strategies/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByTestId("add-level-BUY").click();
  return firstRow(page);
}

/** Opens the row's Configure dialog, lets `change` edit it, and applies it. */
async function configure(
  page: Page,
  row: Locator,
  expectedTitle: string,
  change: (dialog: Locator) => Promise<void>,
): Promise<void> {
  await row.getByTestId("operand-config-button").click();
  const dialog = page.getByTestId("alternative-data-config");
  await expect(
    dialog.getByRole("heading", { name: expectedTitle }),
  ).toBeVisible();
  await change(dialog);
  // The title names the metric, never the lookback being edited below it.
  await expect(
    dialog.getByRole("heading", { name: expectedTitle }),
  ).toBeVisible();
  await dialog.getByTestId("alternative-data-config-apply").click();
  await expect(dialog).toHaveCount(0);
}

/** Every surface that names the row's metric, asserted against one expectation. */
async function expectRowReads(
  page: Page,
  expected: {
    category: { value: string; label: string };
    metric: { value: string; label: string };
    configuration: string;
    sentence: string;
    absent?: readonly string[];
  },
): Promise<void> {
  const row = firstRow(page);
  const metric = row.getByTestId("metric-picker");
  await expect(metric).toHaveAttribute("data-value", expected.metric.value);
  await expect(metric).toHaveText(expected.metric.label);
  // Reopening the picker restores the metric and its category.
  const picker = await openPicker(row);
  const category = picker.locator(
    '[data-testid="metric-picker-category"][aria-pressed="true"]',
  );
  await expect(category).toHaveAttribute("data-value", expected.category.value);
  await expect(category).toHaveText(expected.category.label);
  await expect(
    picker.locator('[data-testid="metric-picker-option"][aria-pressed="true"]'),
  ).toHaveText(expected.metric.label);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
    expected.configuration,
  );
  await expect(row.getByTestId("operand-config-button")).toHaveAttribute(
    "aria-label",
    `Configure ${expected.metric.label}`,
  );
  await expect(page.getByTestId("logic-preview")).toContainText(
    expected.sentence,
  );

  // The explanation follows the metric in hand, configuration included.
  await metric.focus();
  const panel = page.getByTestId("explanation-panel");
  await expect(panel.getByRole("heading")).toHaveText(expected.metric.label);
  await expect(panel.getByTestId("help-category")).toHaveText(
    expected.category.label,
  );
  await expect(panel.getByTestId("help-configuration")).toHaveText(
    expected.configuration,
  );

  for (const text of expected.absent ?? []) {
    await expect(page.getByTestId("strategy-builder")).not.toContainText(text);
  }
}

test.describe("configurable metrics in the Strategy Builder", () => {
  test("A: an Insider metric configured to 180D reads 180D everywhere, through save, reload, edit and duplicate", async ({
    page,
  }) => {
    const name = `E2E insider sellers ${Date.now()}`;
    let sourceId: string | null = null;
    let copyId: string | null = null;
    try {
      const row = await startStrategy(page, name);
      await chooseMetric(row, "INSIDER_ACTIVITY", "INSIDER_ACTIVITY:SELLERS");
      // Strict comparisons only: there is no inclusive form to choose.
      await expect(
        row.getByTestId("operator-select").locator("option"),
      ).toHaveText(["is above", "is below"]);
      await row.getByTestId("value-control").fill("2");
      await configure(
        page,
        row,
        "Configure Insider sellers",
        async (dialog) => {
          await dialog.getByLabel("Lookback").selectOption("180");
          await dialog.getByRole("checkbox", { name: "CFO" }).check();
          await dialog.getByRole("checkbox", { name: "CEO" }).check();
        },
      );

      const reads180 = {
        category: { value: "INSIDER_ACTIVITY", label: "Insider activity" },
        metric: { value: "INSIDER_ACTIVITY:SELLERS", label: "Insider sellers" },
        configuration: "180D · CEO, CFO",
        sentence: "Insider sellers is above 2 (180D · CEO, CFO)",
        absent: ["20D"],
      } as const;
      await expectRowReads(page, reads180);

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      sourceId = strategyIdOf(page);

      // Persisted as identity plus configuration, with the strict operator it was given.
      const saved = await readStrategy(page, sourceId);
      expect(saved.definition.buyLevels[0]?.signal.conditions[0]).toMatchObject(
        {
          metric: {
            kind: "INSIDER_ACTIVITY",
            measure: "SELLERS",
            lookback: 180,
            roles: ["CEO", "CFO"],
          },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 2 },
        },
      );

      // Reload reconstructs exactly the same state.
      await page.reload();
      await expectRowReads(page, reads180);
      await expect(page.getByTestId("save-strategy")).toBeDisabled();

      // Edit the configuration of the saved strategy, save and reload again.
      await configure(
        page,
        firstRow(page),
        "Configure Insider sellers",
        async (dialog) => {
          await expect(dialog.getByLabel("Lookback")).toHaveValue("180");
          await dialog.getByLabel("Lookback").selectOption("60");
        },
      );
      const reads60 = {
        ...reads180,
        configuration: "60D · CEO, CFO",
        sentence: "Insider sellers is above 2 (60D · CEO, CFO)",
        absent: ["180D", "20D"],
      } as const;
      await expectRowReads(page, reads60);
      await page.getByTestId("save-strategy").click();
      await expect(page.getByText("All changes saved")).toBeVisible();
      await page.reload();
      await expectRowReads(page, reads60);
      const edited = await readStrategy(page, sourceId);
      expect(edited.versionNumber).toBe(2);

      // Duplicate from the collection: the copy holds the same logic and reads the same.
      await page.goto("/strategies");
      const collectionRow = page
        .getByTestId("strategies-grid")
        .locator("tbody tr")
        .filter({ hasText: name });
      await chooseFromOverflowMenu(page, name, "Duplicate", collectionRow);
      const dialog = page.getByTestId("duplicate-dialog");
      await dialog.getByLabel("Name").fill(`${name} (copy)`);
      await dialog.getByLabel("Name").press("Enter");
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });
      copyId = strategyIdOf(page);
      expect(copyId).not.toBe(sourceId);
      await expectRowReads(page, reads60);
      const copy = await readStrategy(page, copyId);
      expect(withoutIds(copy.definition)).toEqual(
        withoutIds(edited.definition),
      );
    } finally {
      await deleteStrategies(page, [copyId, sourceId]);
    }
  });

  test("B: Congress purchases configured to 180D and House agrees everywhere, saved and reloaded", async ({
    page,
  }) => {
    const name = `E2E congress purchases ${Date.now()}`;
    let id: string | null = null;
    try {
      const row = await startStrategy(page, name);
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:PURCHASES",
      );
      // A fresh metric starts at its own default configuration.
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        "30D",
      );
      await configure(
        page,
        row,
        "Configure Congress purchases",
        async (dialog) => {
          await dialog.getByLabel("Lookback").selectOption("180");
          await dialog.getByLabel("Chamber").selectOption("HOUSE");
        },
      );

      const reads = {
        category: {
          value: "CONGRESSIONAL_TRADING",
          label: "Congressional trading",
        },
        metric: {
          value: "CONGRESS_ACTIVITY:PURCHASES",
          label: "Congress purchases",
        },
        configuration: "180D · House",
        sentence: "Congress purchases is above 0 (180D · House)",
        absent: ["30D"],
      } as const;
      await expectRowReads(page, reads);

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(
        saved.definition.buyLevels[0]?.signal.conditions[0]?.metric,
      ).toEqual({
        kind: "CONGRESS_ACTIVITY",
        measure: "PURCHASES",
        lookback: 180,
        scope: { kind: "ANY" },
        chamber: "HOUSE",
      });

      await page.reload();
      await expectRowReads(page, reads);
    } finally {
      await deleteStrategies(page, [id]);
    }
  });

  test("C: switching category after configuring an Insider metric leaves nothing behind", async ({
    page,
  }) => {
    const name = `E2E category switch ${Date.now()}`;
    let id: string | null = null;
    try {
      const row = await startStrategy(page, name);
      await chooseMetric(row, "INSIDER_ACTIVITY", "INSIDER_ACTIVITY:BUYERS");
      await configure(page, row, "Configure Insider buyers", async (dialog) => {
        await dialog.getByLabel("Lookback").selectOption("180");
        await dialog.getByRole("checkbox", { name: "CEO" }).check();
      });
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        "180D · CEO",
      );

      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:PURCHASES",
      );
      await expect(row.getByTestId("metric-picker")).toHaveText(
        "Congress purchases",
      );
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        "30D",
      );
      await expect(page.getByTestId("strategy-builder")).not.toContainText(
        "CEO",
      );

      await chooseMetric(row, "OSCILLATORS", "OSCILLATOR:RSI_7D");
      await expect(row.getByTestId("operand-config-button")).toHaveCount(0);
      await expect(
        row.getByTestId("operand-configuration-summary"),
      ).toHaveCount(0);
      const preview = page.getByTestId("logic-preview");
      await expect(preview).toContainText("RSI 7D is above 50");
      for (const stale of ["180D", "CEO", "30D", "Insider", "Congress"]) {
        await expect(preview).not.toContainText(stale);
      }

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(saved.definition.buyLevels[0]?.signal.conditions[0]).toMatchObject(
        {
          metric: { kind: "OSCILLATOR", seriesId: "RSI_7D" },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 50 },
        },
      );
      expect(
        Object.keys(
          saved.definition.buyLevels[0]?.signal.conditions[0]?.metric ?? {},
        ).sort(),
      ).toEqual(["kind", "seriesId"]);
      await page.reload();
      await expect(page.getByTestId("logic-preview")).toContainText(
        "RSI 7D is above 50",
      );
    } finally {
      await deleteStrategies(page, [id]);
    }
  });

  test("D: offers only the strict comparisons as conditions, and keeps the crossing triggers", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E operators ${Date.now()}`);
    await expect(
      row.getByTestId("operator-select").locator("option"),
    ).toHaveText(["is above", "is below", "is close to"]);
    for (const [category, metric] of [
      ["OSCILLATORS", "OSCILLATOR:RSI_14D"],
      ["VOLUME", "RELATIVE_VOLUME:20"],
      ["VALUATION", "MARGIN_OF_SAFETY:DCF_FCFF"],
      ["INSIDER_ACTIVITY", "INSIDER_ACTIVITY:PURCHASE_VALUE"],
      ["CONGRESSIONAL_TRADING", "CONGRESS_ACTIVITY:SELLERS"],
    ] as const) {
      await chooseMetric(row, category, metric);
      await expect(
        row.getByTestId("operator-select").locator("option"),
      ).toHaveText(["is above", "is below"]);
    }

    // A Trigger keeps its event vocabulary, and the condition-only categories are simply absent.
    await page
      .getByTestId("level-card-BUY")
      .first()
      .getByTestId("add-trigger")
      .click();
    const trigger = page
      .getByTestId("level-card-BUY")
      .first()
      .getByTestId("predicate-row")
      .last();
    await expect(
      trigger.getByTestId("operator-select").locator("option"),
    ).toHaveText(["crosses above", "crosses below"]);
    expect(await categoryLabels(await openPicker(trigger))).toEqual([
      "Price",
      "Moving averages",
      "Oscillators",
      "Valuation",
    ]);
  });

  test("E: another measure of the same family keeps the applied filters, and saves them", async ({
    page,
  }) => {
    const name = `E2E carried filters ${Date.now()}`;
    let id: string | null = null;
    try {
      const row = await startStrategy(page, name);
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:BUYERS",
      );
      await configure(
        page,
        row,
        "Configure Congress buyers",
        async (dialog) => {
          await dialog.getByLabel("Lookback").selectOption("90");
          await dialog.getByLabel("Chamber").selectOption("SENATE");
          await dialog.getByRole("checkbox", { name: "Spouse" }).check();
        },
      );
      await row.getByTestId("value-control").fill("3");

      // Every Congressional measure takes the same filters, so they follow the choice — and so does
      // the threshold, which is still a count.
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:SELLERS",
      );
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        "90D · Senate · Spouse",
      );
      await expect(page.getByTestId("logic-preview")).toContainText(
        "Congress sellers is above 3 (90D · Senate · Spouse)",
      );
      // The dialog opens on what was carried, and Cancel leaves it there.
      await row.getByTestId("operand-config-button").click();
      const dialog = page.getByTestId("alternative-data-config");
      await expect(dialog.getByLabel("Lookback")).toHaveValue("90");
      await expect(dialog.getByLabel("Chamber")).toHaveValue("SENATE");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);

      // A measure in another unit keeps the filters and starts its own threshold.
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:MINIMUM_PURCHASE_VALUE",
      );
      await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
        "90D · Senate · Spouse",
      );
      await expect(row.getByTestId("value-control")).toHaveValue("0");
      await chooseMetric(
        row,
        "CONGRESSIONAL_TRADING",
        "CONGRESS_ACTIVITY:SELLERS",
      );
      await row.getByTestId("value-control").fill("3");

      await page.getByTestId("save-strategy").click();
      await expect(page).toHaveURL(/\/strategies\/[0-9a-f-]{36}$/);
      id = strategyIdOf(page);
      const saved = await readStrategy(page, id);
      expect(saved.definition.buyLevels[0]?.signal.conditions[0]).toMatchObject(
        {
          metric: {
            kind: "CONGRESS_ACTIVITY",
            measure: "SELLERS",
            lookback: 90,
            scope: { kind: "ANY" },
            chamber: "SENATE",
            owners: ["SPOUSE"],
          },
          operator: "IS_ABOVE",
          value: { kind: "NUMBER", value: 3 },
        },
      );

      // Another family does not inherit them.
      await page.reload();
      await chooseMetric(
        firstRow(page),
        "INSIDER_ACTIVITY",
        "INSIDER_ACTIVITY:SELLERS",
      );
      await expect(
        firstRow(page).getByTestId("operand-configuration-summary"),
      ).toHaveText("20D");
    } finally {
      await deleteStrategies(page, [id]);
    }
  });

  test("reads a rule as one line of three fields on a desktop, and opens the picker beneath it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const row = await startStrategy(page, `E2E layout ${Date.now()}`);
    await chooseMetric(row, "VALUATION", "MARGIN_OF_SAFETY:DCF_FCFF");
    const boxes = await Promise.all(
      ["metric-picker", "operator-select", "value-control"].map((testId) =>
        row.getByTestId(testId).boundingBox(),
      ),
    );
    const [metric] = boxes;
    for (const box of boxes) {
      expect(box).toBeTruthy();
      expect(Math.abs(box!.y - metric!.y)).toBeLessThanOrEqual(1);
      expect(box!.width).toBeGreaterThanOrEqual(100);
    }
    // In order, left to right, and inside the level card rather than wider than it.
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index]!.x).toBeGreaterThan(boxes[index - 1]!.x);
    }
    const card = await page.getByTestId("level-card-BUY").first().boundingBox();
    const last = boxes.at(-1)!;
    expect(last.x + last.width).toBeLessThanOrEqual(card!.x + card!.width);

    // The popover opens beside the row — beneath it, or above it when the viewport has more room
    // there — never over it and never off screen, with the eight BUY categories as two rows of four.
    const panel = await openPicker(row);
    const panelBox = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(
      panelBox.y >= metric!.y + metric!.height ||
        panelBox.y + panelBox.height <= metric!.y,
    ).toBe(true);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
    const tiles = await Promise.all(
      (await panel.getByTestId("metric-picker-category").all()).map((tile) =>
        tile.boundingBox(),
      ),
    );
    expect(tiles).toHaveLength(8);
    const rows = [...new Set(tiles.map((tile) => Math.round(tile!.y)))];
    expect(rows).toHaveLength(2);
    expect(
      tiles.filter((tile) => Math.round(tile!.y) === rows[0]),
    ).toHaveLength(4);

    // A category's metrics sit below in two columns; only they scroll, and neither a change of
    // category nor scrolling moves the categories.
    const tileTop = async () =>
      (await panel.getByTestId("metric-picker-category").first().boundingBox())!
        .y;
    await showCategory(panel, "FUNDAMENTALS");
    expect(await tileTop()).toBe(tiles[0]!.y);
    const options = panel.getByTestId("metric-picker-option");
    const [firstOption, secondOption, thirdOption] = await Promise.all(
      [0, 1, 2].map((index) => options.nth(index).boundingBox()),
    );
    expect(Math.abs(firstOption!.y - secondOption!.y)).toBeLessThanOrEqual(1);
    expect(secondOption!.x).toBeGreaterThan(firstOption!.x);
    expect(thirdOption!.y).toBeGreaterThan(firstOption!.y);
    const scroller = panel.getByTestId("metric-picker-options");
    await expect(scroller).toHaveCSS("overflow-y", "auto");
    await scroller.evaluate((element) =>
      element.scrollTo(0, element.scrollHeight),
    );
    await expect(options.last()).toBeInViewport();
    expect(await tileTop()).toBe(tiles[0]!.y);
    await showCategory(panel, "PRICE");
    expect(await tileTop()).toBe(tiles[0]!.y);

    // Choosing closes it; reopening restores both the metric and its category.
    await showCategory(panel, "FUNDAMENTALS");
    await options.filter({ hasText: "ROIC TTM" }).click();
    await expect(panel).toBeHidden();
    await expect(row.getByTestId("metric-picker")).toHaveText("ROIC TTM");
    await openPicker(row);
    await expect(
      panel.locator(
        '[data-testid="metric-picker-category"][aria-pressed="true"]',
      ),
    ).toHaveText("Fundamentals");
    await expect(
      panel.locator(
        '[data-testid="metric-picker-option"][aria-pressed="true"]',
      ),
    ).toHaveText("ROIC TTM");
    // A press elsewhere — here the explanation rail beside it — closes it without changing the rule.
    await page
      .getByTestId("explanation-panel")
      .click({ position: { x: 8, y: 8 } });
    await expect(panel).toBeHidden();
    await expect(row.getByTestId("metric-picker")).toHaveText("ROIC TTM");
  });
});

test.describe("configurable metrics on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens Configure on a second row while the explanation sits under the first", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E phone two rows ${Date.now()}`);
    await chooseMetric(row, "INSIDER_ACTIVITY", "INSIDER_ACTIVITY:SELLERS");
    await configure(page, row, "Configure Insider sellers", async (dialog) => {
      await dialog.getByLabel("Lookback").selectOption("180");
    });
    const buy = page.getByTestId("level-card-BUY").first();
    await buy.getByTestId("add-condition").click();
    const second = buy.getByTestId("predicate-row").nth(1);
    await chooseMetric(
      second,
      "CONGRESSIONAL_TRADING",
      "CONGRESS_ACTIVITY:PURCHASES",
    );

    // On a phone the explanation is drawn under the focused row. Pressing the second row's
    // Configure must not move it: a layout shift between press and release would hand the click
    // to an ancestor, and the dialog would never open.
    await row.getByTestId("metric-picker").focus();
    await expect(row.getByTestId("inline-help")).toBeVisible();
    await configure(
      page,
      second,
      "Configure Congress purchases",
      async (dialog) => {
        await dialog.getByLabel("Chamber").selectOption("SENATE");
      },
    );
    await expect(
      second.getByTestId("operand-configuration-summary"),
    ).toHaveText("30D · Senate");
    await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
      "180D",
    );
  });

  test("configures a Congress metric in one column, without sideways scrolling", async ({
    page,
  }) => {
    const row = await startStrategy(page, `E2E phone congress ${Date.now()}`);
    await chooseMetric(
      row,
      "CONGRESSIONAL_TRADING",
      "CONGRESS_ACTIVITY:BUYERS",
    );
    await configure(page, row, "Configure Congress buyers", async (dialog) => {
      await dialog.getByLabel("Lookback").selectOption("90");
      await dialog.getByLabel("Chamber").selectOption("SENATE");
      await dialog.getByRole("checkbox", { name: "Spouse" }).check();
    });
    await expect(row.getByTestId("operand-configuration-summary")).toHaveText(
      "90D · Senate · Spouse",
    );
    await expect(page.getByTestId("logic-preview")).toContainText(
      "Congress buyers is above 0 (90D · Senate · Spouse)",
    );

    // The Metric has the first line, Condition and Value share the second.
    const [metric, operator, value] = await Promise.all(
      ["metric-picker", "operator-select", "value-control"].map((testId) =>
        row.getByTestId(testId).boundingBox(),
      ),
    );
    expect(Math.abs(value!.y - operator!.y)).toBeLessThanOrEqual(1);
    expect(operator!.y).toBeGreaterThan(metric!.y);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
