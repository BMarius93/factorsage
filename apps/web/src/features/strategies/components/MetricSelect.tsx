"use client";

import {
  STRATEGY_METRIC_GROUP_LABELS,
  strategyMetricOptions,
  type StrategyLevelKind,
  type StrategyMetric,
} from "@intrinsic/contracts";
import { useMemo } from "react";
import { metricKey } from "../utils/strategy-draft";
import { Select } from "../../../components/ui/Select";

type MetricSelectProps = {
  readonly levelKind: StrategyLevelKind;
  readonly metric: StrategyMetric;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (metric: StrategyMetric) => void;
  readonly onFocus: (metric: StrategyMetric) => void;
  readonly onBlur: () => void;
  /** The row has no Metric chosen yet: the control opens on "Choose a metric…". */
  readonly unset?: boolean;
};

/**
 * The Metric control.
 *
 * Its options are `strategyMetricOptions(levelKind)` and nothing else: the registry decides which
 * metrics exist, their labels, their grouping and their order, and which of them a level kind may
 * use. `Gain` and `Loss` are simply absent for BUY rather than filtered out here.
 */
export function MetricSelect({
  levelKind,
  metric,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
  unset = false,
}: MetricSelectProps) {
  const options = strategyMetricOptions(levelKind);

  // Consecutive options of one group, in the registry's own order — never a second ordering array.
  const groups = useMemo(() => {
    const built: {
      id: string;
      label: string;
      options: typeof options extends readonly (infer T)[] ? T[] : never;
    }[] = [];
    for (const option of options) {
      const last = built[built.length - 1];
      if (last && last.id === option.group) {
        last.options.push(option);
      } else {
        built.push({
          id: option.group,
          label: STRATEGY_METRIC_GROUP_LABELS[option.group],
          options: [option],
        });
      }
    }
    return built;
  }, [options]);

  const selected = unset ? "" : metricKey(metric);

  return (
    <Select
      density="compact"
      testId="metric-select"
      aria-label={label}
      invalid={invalid}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={selected}
      onFocus={() => {
        if (!unset) {
          onFocus(metric);
        }
      }}
      onBlur={onBlur}
      onValueChange={(value) => {
        const next = options.find(
          (option) => metricKey(option.metric) === value,
        );
        if (next) {
          onChange(next.metric);
          onFocus(next.metric);
        }
      }}
      // A saved strategy can carry a Metric a level no longer offers — for example after a product
      // change. `Select` keeps it readable as "Unavailable metric" instead of silently showing the
      // wrong metric; validation is what reports it.
      {...(unset
        ? { placeholder: "Choose a metric…", placeholderDisabled: true }
        : {})}
      unavailableLabel="Unavailable metric"
      groups={groups.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({
          value: metricKey(option.metric),
          label: option.label,
        })),
      }))}
    />
  );
}
