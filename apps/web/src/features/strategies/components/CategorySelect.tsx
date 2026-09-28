"use client";

import {
  STRATEGY_METRIC_CATEGORY_LABELS,
  strategyMetricCategories,
  strategyMetricCategory,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricCategoryId,
  type StrategyPredicatePart,
} from "@intrinsic/contracts";
import { Select } from "../../../components/ui/Select";

type CategorySelectProps = {
  readonly levelKind: StrategyLevelKind;
  /** Which half of the Signal this row is: the registry decides which categories each may offer. */
  readonly part: StrategyPredicatePart;
  /** The row's metric. Its category is read from it, never held beside it. */
  readonly metric: StrategyMetric;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (category: StrategyMetricCategoryId) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
};

/**
 * The first of the two Metric controls: which family of metrics the rule reads.
 *
 * Its options are `strategyMetricCategories(levelKind, part)` and nothing else, so `Position` is
 * absent from a BUY level and the condition-only families are absent from a Trigger row because the
 * registry says so. Its value is the metric's own category, so it can never disagree with the Metric
 * control beside it; choosing a category asks the draft to install that category's first metric.
 */
export function CategorySelect({
  levelKind,
  part,
  metric,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
}: CategorySelectProps) {
  const category = strategyMetricCategory(metric);
  return (
    <Select
      density="compact"
      testId="metric-category-select"
      aria-label={label}
      title={STRATEGY_METRIC_CATEGORY_LABELS[category]}
      invalid={invalid}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={category}
      onFocus={onFocus}
      onBlur={onBlur}
      onValueChange={(value) => {
        if (value !== category) {
          onChange(value as StrategyMetricCategoryId);
        }
      }}
      // A saved strategy can carry a metric whose category this level does not offer — `Gain` in a
      // BUY level after a product change. It reads as unavailable instead of silently showing
      // another category; validation is what reports it and names the metric.
      unavailableLabel="Unavailable category"
      options={strategyMetricCategories(levelKind, part).map((entry) => ({
        value: entry.id,
        label: entry.label,
      }))}
    />
  );
}
