import { findSelectableSeries } from "@intrinsic/contracts";
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

/** Shows one category of an open popover, by its id (`OSCILLATORS`, `MOVING_AVERAGES_DAILY`). */
export async function showCategory(
  panel: Locator,
  category: string,
): Promise<void> {
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

/** The labels of the category tiles of an open popover, in order. */
export async function categoryLabels(panel: Locator): Promise<string[]> {
  return (
    await panel.locator('[data-testid$="-category"]').allTextContents()
  ).map((text) => text.trim());
}

/** The labels of the options the shown category offers, in order. */
export async function optionLabels(panel: Locator): Promise<string[]> {
  return (
    await panel.locator('[data-testid$="-option"]').allTextContents()
  ).map((text) => text.trim());
}
