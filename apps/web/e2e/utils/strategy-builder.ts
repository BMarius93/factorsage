import {
  STRATEGY_METRIC_CATEGORY_FAMILIES,
  findSelectableSeries,
} from "@intrinsic/contracts";
import { expect, type Locator } from "@playwright/test";

/** The two pickers of a rule row: its Metric, and its Value when that is a series. */
export type PickerTestId = "metric-picker" | "value-control";

/** Opens a row's picker (if it is not open already) and returns its popover. */
export async function openPicker(
  row: Locator,
  testId: PickerTestId = "metric-picker",
): Promise<Locator> {
  const panel = row.getByTestId(`${testId}-panel`);
  if (!(await panel.isVisible())) {
    await row.getByTestId(testId).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

// ---------------------------------------------------------------------------
// The Metric picker's own levels: data source, family, subgroup
// ---------------------------------------------------------------------------

/** The family tabs of an open Metric picker, in order: `Technical`, `Fundamentals`, … */
export async function familyLabels(panel: Locator): Promise<string[]> {
  return (
    await panel.getByTestId("metric-picker-family").allTextContents()
  ).map((text) => text.trim());
}

/** Shows one family of an open Metric picker, by its id (`TECHNICAL`). */
export async function showFamily(panel: Locator, family: string): Promise<void> {
  const tab = panel.locator(
    `[data-testid="metric-picker-family"][data-value="${family}"]`,
  );
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    await tab.click();
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("metric-picker-options")).toHaveAttribute(
    "data-family",
    family,
  );
}

/** One of the two data-source choices of an open Metric picker. */
export type PickerSource = "STOCK" | "ETF" | "STOCK_SECTOR";

export function sourceChoice(panel: Locator, source: PickerSource): Locator {
  return panel.locator(
    `[data-testid="metric-picker-source"][data-value="${source}"]`,
  );
}

/**
 * Chooses the data source of an open Metric picker.
 *
 * The radio itself is visually replaced by its face, so the choice is made the way a pointer makes
 * it: on the label that wraps both.
 */
export async function chooseSource(
  panel: Locator,
  source: PickerSource,
): Promise<void> {
  const radio = sourceChoice(panel, source);
  if (!(await radio.isChecked())) {
    await radio.check({ force: true });
  }
  await expect(radio).toBeChecked();
}

/** Chooses the ETF an open Metric picker reads, by its benchmark code (`ETF_XLK`). */
export async function chooseEtf(panel: Locator, code: string): Promise<void> {
  await chooseSource(panel, "ETF");
  const select = panel.getByTestId("metric-picker-etf");
  await select.selectOption(code);
  await expect(select).toHaveValue(code);
}

// ---------------------------------------------------------------------------
// Categories and options, in both pickers
// ---------------------------------------------------------------------------

/**
 * Shows one category of an open popover, by its id (`OSCILLATORS`, `MOVING_AVERAGES_DAILY`).
 *
 * In the Value picker that is a tile. In the Metric picker it is the category's family tab and, where
 * the family has several categories, the category's own subgroup — opened if it is not already.
 */
export async function showCategory(
  panel: Locator,
  category: string,
): Promise<void> {
  const family = (
    STRATEGY_METRIC_CATEGORY_FAMILIES as Partial<Record<string, string>>
  )[category];
  if (
    family !== undefined &&
    (await panel.getByTestId("metric-picker-family").count()) > 0
  ) {
    await showFamily(panel, family);
    const header = panel.locator(
      `[data-testid="metric-picker-category"][data-value="${category}"]`,
    );
    if ((await header.count()) > 0) {
      if ((await header.getAttribute("aria-expanded")) !== "true") {
        await header.click();
      }
      await expect(header).toHaveAttribute("aria-expanded", "true");
    }
    await expect(
      panel.locator(`[data-option-grid][data-category="${category}"]`),
    ).toBeVisible();
    return;
  }
  const tile = panel.locator(
    `[data-testid$="-category"][data-value="${category}"]`,
  );
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
}

/**
 * Chooses a rule's Metric the way a user does: open the Metric picker, show the category, choose the
 * metric — which closes the picker.
 *
 * Values are the registry's own: a category id (`OSCILLATORS`) and a metric key
 * (`OSCILLATOR:RSI_14D`).
 */
export async function chooseMetric(
  row: Locator,
  category: string,
  metric: string,
): Promise<void> {
  const panel = await openPicker(row, "metric-picker");
  await showCategory(panel, category);
  await panel
    .locator(`[data-testid="metric-picker-option"][data-value="${metric}"]`)
    .click();
  await expect(panel).toBeHidden();
  await expect(row.getByTestId("metric-picker")).toHaveAttribute(
    "data-value",
    metric,
  );
}

/**
 * Chooses a rule's Metric from an ETF: open the picker, choose the ETF, show the category, choose
 * the metric. `metric` is the ETF-sourced key exactly as the registry spells it
 * (`ETF(ETF_XLK)|OSCILLATOR:RSI_14D`).
 *
 * Choosing the ETF alone already moves the rule when the fund offers the metric the row holds, so
 * the option may be the pressed one by the time it is clicked; clicking it closes the picker either
 * way.
 */
export async function chooseEtfMetric(
  row: Locator,
  code: string,
  category: string,
  metric: string,
): Promise<void> {
  const panel = await openPicker(row, "metric-picker");
  await chooseEtf(panel, code);
  await showCategory(panel, category);
  await panel
    .locator(`[data-testid="metric-picker-option"][data-value="${metric}"]`)
    .click();
  await expect(panel).toBeHidden();
  await expect(row.getByTestId("metric-picker")).toHaveAttribute(
    "data-value",
    metric,
  );
}

/** Moves one rule to Stock's Sector and chooses one of its metrics (`STOCK_SECTOR|PRICE:`). */
export async function chooseSectorMetric(
  row: Locator,
  category: string,
  metric: string,
): Promise<void> {
  const panel = await openPicker(row, "metric-picker");
  await chooseSource(panel, "STOCK_SECTOR");
  await showCategory(panel, category);
  await panel
    .locator(`[data-testid="metric-picker-option"][data-value="${metric}"]`)
    .click();
  await expect(panel).toBeHidden();
  await expect(row.getByTestId("metric-picker")).toHaveAttribute(
    "data-value",
    metric,
  );
}

/** Chooses the series a rule compares with, from the category the catalog files it under. */
export async function chooseSeriesValue(
  row: Locator,
  seriesId: string,
): Promise<void> {
  const group = findSelectableSeries(seriesId)?.group;
  if (!group) {
    throw new Error(`${seriesId} is not a catalog series`);
  }
  const panel = await openPicker(row, "value-control");
  await showCategory(panel, group);
  await panel
    .locator(`[data-testid="value-control-option"][data-value="${seriesId}"]`)
    .click();
  await expect(panel).toBeHidden();
  await expect(row.getByTestId("value-control")).toHaveAttribute(
    "data-value",
    seriesId,
  );
}

/**
 * The categories on show, in order: the Value picker's tiles, or the subgroups of the Metric
 * picker's shown family. A family with a single category has no subgroup, and so no label here.
 */
export async function categoryLabels(panel: Locator): Promise<string[]> {
  const tiles = await panel.locator('[data-testid$="-category"]').all();
  return Promise.all(
    tiles.map(async (tile) =>
      // A subgroup header also prints how many metrics it holds; the label is the name alone.
      (
        (await tile.getAttribute("data-label")) ??
        (await tile.textContent()) ??
        ""
      ).trim(),
    ),
  );
}

/** The labels of the options on show, in order. */
export async function optionLabels(panel: Locator): Promise<string[]> {
  return (
    await panel.locator('[data-testid$="-option"]').allTextContents()
  ).map((text) => text.trim());
}
