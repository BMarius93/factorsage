import { findSelectableSeries } from "@intrinsic/contracts";
import { within } from "@testing-library/react";

/**
 * Just the part of `user-event` these helpers need, so a spec may pass either the default export or
 * an instance from `userEvent.setup()`.
 */
type Clicker = { readonly click: (element: Element) => Promise<unknown> };

/** The two pickers of a rule row: its Metric, and its Value when that is a series. */
export type PickerTestId = "metric-picker" | "value-control";

/** The picker's trigger in one rule row. */
export function pickerTrigger(
  row: HTMLElement,
  testId: PickerTestId = "metric-picker",
): HTMLButtonElement {
  return within(row).getByTestId(testId) as HTMLButtonElement;
}

/** The identity the picker holds: a metric key (`OSCILLATOR:RSI_14D`) or a series id. */
export function pickerValue(
  row: HTMLElement,
  testId: PickerTestId = "metric-picker",
): string {
  return pickerTrigger(row, testId).getAttribute("data-value") ?? "";
}

/** What the picker's trigger reads. */
export function pickerText(
  row: HTMLElement,
  testId: PickerTestId = "metric-picker",
): string {
  return pickerTrigger(row, testId).textContent ?? "";
}

/** The open popover of one row's picker, or `null` when it is closed. */
export function pickerPanel(
  row: HTMLElement,
  testId: PickerTestId = "metric-picker",
): HTMLElement | null {
  return within(row).queryByTestId(`${testId}-panel`);
}

/** Opens a row's picker and returns its popover. */
export async function openPicker(
  user: Clicker,
  row: HTMLElement,
  testId: PickerTestId = "metric-picker",
): Promise<HTMLElement> {
  const open = pickerPanel(row, testId);
  if (open) {
    return open;
  }
  await user.click(pickerTrigger(row, testId));
  const panel = pickerPanel(row, testId);
  if (!panel) {
    throw new Error(`${testId} did not open`);
  }
  return panel;
}

/** The category tiles of an open popover, in order. */
export function categoryLabels(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByTestId(/-category$/)
    .map((tile) => tile.textContent ?? "");
}

/** The category tile being shown. */
export function activeCategory(panel: HTMLElement): string | null {
  const tile = within(panel)
    .getAllByTestId(/-category$/)
    .find((candidate) => candidate.getAttribute("aria-pressed") === "true");
  return tile?.getAttribute("data-value") ?? null;
}

/** The options the shown category offers, in order. */
export function optionLabels(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByTestId(/-option$/)
    .map((option) => option.textContent ?? "");
}

/** Shows one category of an open popover, by its id (`OSCILLATORS`, `MOVING_AVERAGES_DAILY`). */
export async function showCategory(
  user: Clicker,
  panel: HTMLElement,
  category: string,
): Promise<void> {
  const tile = within(panel)
    .getAllByTestId(/-category$/)
    .find((candidate) => candidate.getAttribute("data-value") === category);
  if (!tile) {
    throw new Error(`category ${category} is not offered`);
  }
  await user.click(tile);
}

/**
 * Chooses a rule's Metric the way a user does: open the picker, show the category, choose the metric.
 * Values are the registry's own: a category id (`OSCILLATORS`) and a metric key (`OSCILLATOR:RSI_14D`).
 */
export async function chooseMetric(
  user: Clicker,
  row: HTMLElement,
  category: string,
  metric: string,
): Promise<void> {
  const panel = await openPicker(user, row, "metric-picker");
  await showCategory(user, panel, category);
  const option = within(panel)
    .getAllByTestId("metric-picker-option")
    .find((candidate) => candidate.getAttribute("data-value") === metric);
  if (!option) {
    throw new Error(`metric ${metric} is not offered in ${category}`);
  }
  await user.click(option);
}

/** Chooses the series a rule compares with, from the category the catalog files it under. */
export async function chooseSeriesValue(
  user: Clicker,
  row: HTMLElement,
  seriesId: string,
): Promise<void> {
  const group = findSelectableSeries(seriesId)?.group;
  if (!group) {
    throw new Error(`${seriesId} is not a catalog series`);
  }
  const panel = await openPicker(user, row, "value-control");
  await showCategory(user, panel, group);
  const option = within(panel)
    .getAllByTestId("value-control-option")
    .find((candidate) => candidate.getAttribute("data-value") === seriesId);
  if (!option) {
    throw new Error(`${seriesId} is not offered`);
  }
  await user.click(option);
}
