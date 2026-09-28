"use client";

import {
  strategyMetricCategories,
  strategyMetricCategory,
  strategyMetricKey,
  strategyMetricLabel,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyPredicatePart,
} from "@intrinsic/contracts";
import { Select } from "../../../components/ui/Select";

type MetricSelectProps = {
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
 * The second of the two Metric controls: which metric of the row's category it reads.
 *
 * Its options are the metrics `strategyMetricCategories(levelKind, part)` lists for the metric's own
 * category, each named by its identity label — `Insider sellers`, never `Insider sellers 20D`. A
 * metric's configuration is not part of its identity: it is edited after the metric is chosen and
 * summarized beneath the row, so this control reads the same whatever the lookback or filters are,
 * and no option ever enumerates a configuration.
 *
 * Choosing an option installs that metric at its canonical default configuration.
 */
export function MetricSelect({
  levelKind,
  part,
  metric,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
}: MetricSelectProps) {
  const category = strategyMetricCategory(metric);
  const options =
    strategyMetricCategories(levelKind, part).find(
      (entry) => entry.id === category,
    )?.options ?? [];
  const selected = strategyMetricKey(metric);

  return (
    <Select
      density="compact"
      testId="metric-select"
      aria-label={label}
      // A long metric truncates in a narrow row; the full label stays available on hover and is
      // what the native picker shows either way.
      title={strategyMetricLabel(metric)}
      invalid={invalid}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={selected}
      onFocus={onFocus}
      onBlur={onBlur}
      onValueChange={(value) => {
        const next = options.find(
          (option) => strategyMetricKey(option.metric) === value,
        );
        if (next && value !== selected) {
          onChange(next.metric);
        }
      }}
      // A saved strategy can carry a Metric a level no longer offers — for example after a product
      // change. `Select` keeps it readable as "Unavailable metric" instead of silently showing the
      // wrong metric; validation is what reports it.
      unavailableLabel="Unavailable metric"
      options={options.map((option) => ({
        value: strategyMetricKey(option.metric),
        label: option.label,
      }))}
    />
  );
}
