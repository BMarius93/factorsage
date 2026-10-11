"use client";

import {
  strategyMetricCategories,
  strategyMetricCategory,
  strategyMetricKey,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyPredicatePart,
} from "@intrinsic/contracts";
import { OperandPicker } from "./OperandPicker";

type MetricPickerProps = {
  readonly levelKind: StrategyLevelKind;
  /** Which half of the Signal this row is: the registry decides what each may offer. */
  readonly part: StrategyPredicatePart;
  readonly metric: StrategyMetric;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (metric: StrategyMetric) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
};

/**
 * The Metric control: the category and the metric within it, in one popover.
 *
 * Its categories and their metrics are `strategyMetricCategories(levelKind, part)` and nothing else,
 * so `Position` is absent from a BUY level and the condition-only families are absent from a Trigger
 * row because the registry says so. Each metric is named by its identity label — `Insider sellers`,
 * never `Insider sellers 20D`: a configuration is edited after the metric is chosen and summarized
 * beneath the row, so no option ever enumerates one.
 *
 * Choosing an option hands the registry's own instance of that metric to the draft, which decides
 * what of the previous rule survives (`chooseMetric`).
 */
export function MetricPicker({
  levelKind,
  part,
  metric,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
}: MetricPickerProps) {
  const categories = strategyMetricCategories(levelKind, part);
  const selectedKey = strategyMetricKey(metric);
  const selected = categories
    .flatMap((category) => category.options)
    .find((option) => strategyMetricKey(option.metric) === selectedKey);

  return (
    <OperandPicker
      label={label}
      testId="metric-picker"
      categories={categories.map((category) => ({
        id: category.id,
        label: category.label,
        options: category.options.map((option) => ({
          key: strategyMetricKey(option.metric),
          label: option.label,
        })),
      }))}
      selectedKey={selectedKey}
      selectedCategoryId={strategyMetricCategory(metric)}
      // A saved strategy can carry a metric this level no longer offers — `Gain` in a BUY level after
      // a product change. It reads as unavailable instead of silently showing another metric;
      // validation is what reports it and names the metric.
      display={selected?.label ?? "Unavailable metric"}
      invalid={invalid}
      {...(describedBy ? { describedBy } : {})}
      onSelect={(key) => {
        const next = categories
          .flatMap((category) => category.options)
          .find((option) => strategyMetricKey(option.metric) === key);
        if (next) {
          onChange(next.metric);
        }
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}
