import type { Locator } from "@playwright/test";

/**
 * Chooses a rule's Metric the way a user does: its category first, then the metric within it.
 *
 * The Builder names a metric with two selects — `metric-category-select` and `metric-select` — and a
 * category change installs that category's first metric, so the metric is only chosen afterwards and
 * only when it differs. Values are the registry's own: a category id (`OSCILLATORS`) and a metric key
 * (`OSCILLATOR:RSI_14D`).
 */
export async function chooseMetric(
  row: Locator,
  category: string,
  metric: string,
): Promise<void> {
  await row.getByTestId("metric-category-select").selectOption(category);
  const select = row.getByTestId("metric-select");
  if ((await select.inputValue()) !== metric) {
    await select.selectOption(metric);
  }
}
