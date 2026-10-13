import {
  STRATEGY_METRIC_CATEGORY_FAMILIES,
  findSelectableSeries,
  type StrategyMetricCategoryId,
} from "@intrinsic/contracts";
import { within } from "@testing-library/react";

/**
 * Just the part of `user-event` these helpers need, so a spec may pass either the default export or
 * an instance from `userEvent.setup()`.
 */
type Clicker = {
  readonly click: (element: Element) => Promise<unknown>;
  readonly selectOptions: (
    element: Element,
    values: string | string[],
  ) => Promise<unknown>;
};

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

// ---------------------------------------------------------------------------
// The Metric picker's own levels: data source, family, subgroup
// ---------------------------------------------------------------------------

function familyTabs(panel: HTMLElement): HTMLElement[] {
  return within(panel).queryAllByTestId("metric-picker-family");
}

/** The family tabs of an open Metric picker, in order: `Technical`, `Fundamentals`, … */
export function familyLabels(panel: HTMLElement): string[] {
  return familyTabs(panel).map((tab) => tab.textContent ?? "");
}

/** The family being shown, by id (`TECHNICAL`). */
export function activeFamily(panel: HTMLElement): string | null {
  return (
    familyTabs(panel)
      .find((tab) => tab.getAttribute("aria-selected") === "true")
      ?.getAttribute("data-value") ?? null
  );
}

/** Shows one family of an open Metric picker, by its id. */
export async function showFamily(
  user: Clicker,
  panel: HTMLElement,
  family: string,
): Promise<void> {
  const tab = familyTabs(panel).find(
    (candidate) => candidate.getAttribute("data-value") === family,
  );
  if (!tab) {
    throw new Error(`family ${family} is not offered`);
  }
  if (tab.getAttribute("aria-selected") !== "true") {
    await user.click(tab);
  }
}

/** The data source an open Metric picker is showing. */
export function shownSource(panel: HTMLElement): "STOCK" | "ETF" {
  const checked = within(panel)
    .getAllByTestId("metric-picker-source")
    .find((radio) => (radio as HTMLInputElement).checked);
  return checked?.getAttribute("data-value") === "ETF" ? "ETF" : "STOCK";
}

/** Chooses the data source of an open Metric picker. */
export async function chooseSource(
  user: Clicker,
  panel: HTMLElement,
  source: "STOCK" | "ETF",
): Promise<void> {
  const radio = within(panel)
    .getAllByTestId("metric-picker-source")
    .find((candidate) => candidate.getAttribute("data-value") === source);
  if (!radio) {
    throw new Error(`source ${source} is not offered`);
  }
  await user.click(radio);
}

/** The ETF select of an open Metric picker; present only while the source is ETF. */
export function etfSelect(panel: HTMLElement): HTMLSelectElement | null {
  return within(panel).queryByTestId(
    "metric-picker-etf",
  ) as HTMLSelectElement | null;
}

/** Chooses the ETF an open Metric picker reads, by its benchmark code (`ETF_XLK`). */
export async function chooseEtf(
  user: Clicker,
  panel: HTMLElement,
  code: string,
): Promise<void> {
  if (shownSource(panel) !== "ETF") {
    await chooseSource(user, panel, "ETF");
  }
  const select = etfSelect(panel);
  if (!select) {
    throw new Error("the ETF select is not shown");
  }
  if (select.value !== code) {
    await user.selectOptions(select, code);
  }
}

// ---------------------------------------------------------------------------
// Categories and options, in both pickers
// ---------------------------------------------------------------------------

/**
 * The categories on show, in order: the Value picker's tiles, or the subgroups of the Metric
 * picker's shown family. A family with a single category has no subgroup, and so no label here.
 */
export function categoryLabels(panel: HTMLElement): string[] {
  return within(panel)
    .queryAllByTestId(/-category$/)
    .map((tile) =>
      // A subgroup header also prints how many metrics it holds; the label is the name alone.
      (tile.getAttribute("data-label") ?? tile.textContent ?? "").trim(),
    );
}

/** The category whose options are on show, by id; `null` when none is. */
export function activeCategory(panel: HTMLElement): string | null {
  return (
    panel
      .querySelector("[data-option-grid][data-category]")
      ?.getAttribute("data-category") ?? null
  );
}

/** The options on show, in order. */
export function optionLabels(panel: HTMLElement): string[] {
  return within(panel)
    .queryAllByTestId(/-option$/)
    .map((option) => option.textContent ?? "");
}

/**
 * Shows one category of an open popover, by its id (`OSCILLATORS`, `MOVING_AVERAGES_DAILY`).
 *
 * In the Value picker that is a tile. In the Metric picker it is the category's family tab and, where
 * the family has several categories, the category's own subgroup — opened if it is not already.
 */
export async function showCategory(
  user: Clicker,
  panel: HTMLElement,
  category: string,
): Promise<void> {
  const family = (
    STRATEGY_METRIC_CATEGORY_FAMILIES as Partial<Record<string, string>>
  )[category as StrategyMetricCategoryId];
  if (familyTabs(panel).length > 0 && family !== undefined) {
    await showFamily(user, panel, family);
    const header = within(panel)
      .queryAllByTestId("metric-picker-category")
      .find((candidate) => candidate.getAttribute("data-value") === category);
    if (header) {
      if (header.getAttribute("aria-expanded") !== "true") {
        await user.click(header);
      }
      return;
    }
    if (activeCategory(panel) !== category) {
      throw new Error(`category ${category} is not offered`);
    }
    return;
  }
  const tile = within(panel)
    .queryAllByTestId(/-category$/)
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
    .queryAllByTestId("metric-picker-option")
    .find((candidate) => candidate.getAttribute("data-value") === metric);
  if (!option) {
    throw new Error(`metric ${metric} is not offered in ${category}`);
  }
  await user.click(option);
}

/**
 * Chooses a rule's Metric from an ETF: open the picker, choose the ETF, show the category, choose
 * the metric. `metric` is the ETF-sourced key, exactly as the registry spells it
 * (`ETF(ETF_XLK)|OSCILLATOR:RSI_14D`).
 */
export async function chooseEtfMetric(
  user: Clicker,
  row: HTMLElement,
  code: string,
  category: string,
  metric: string,
): Promise<void> {
  const panel = await openPicker(user, row, "metric-picker");
  await chooseEtf(user, panel, code);
  // Choosing the ETF may already have made the rule that metric; the picker is still open either way.
  if (pickerValue(row) === metric) {
    await user.click(pickerTrigger(row));
    return;
  }
  await showCategory(user, panel, category);
  const option = within(panel)
    .queryAllByTestId("metric-picker-option")
    .find((candidate) => candidate.getAttribute("data-value") === metric);
  if (!option) {
    throw new Error(`metric ${metric} is not offered by ${code} in ${category}`);
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
