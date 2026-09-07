"use client";

import {
  STRATEGY_METRIC_GROUP_LABELS,
  strategyMetricOptions,
  type StrategyLevelKind,
  type StrategyMetric,
} from "@intrinsic/contracts";
import { useMemo } from "react";
import { metricKey } from "../utils/strategy-draft";
import styles from "./StrategyBuilder.module.css";

type MetricSelectProps = {
  readonly levelKind: StrategyLevelKind;
  readonly metric: StrategyMetric;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (metric: StrategyMetric) => void;
  readonly onFocus: (metric: StrategyMetric) => void;
  readonly onBlur: () => void;
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

  const selected = metricKey(metric);

  return (
    <select
      className={styles.select}
      data-testid="metric-select"
      aria-label={label}
      aria-invalid={invalid || undefined}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={selected}
      onFocus={() => onFocus(metric)}
      onBlur={onBlur}
      onChange={(event) => {
        const next = options.find(
          (option) => metricKey(option.metric) === event.target.value,
        );
        if (next) {
          onChange(next.metric);
          onFocus(next.metric);
        }
      }}
    >
      {/*
        A saved strategy can carry a Metric a level no longer offers — for example after a product
        change. Rendering it keeps the row readable instead of silently showing the wrong metric;
        validation is what reports it.
      */}
      {options.some((option) => metricKey(option.metric) === selected) ? null : (
        <option value={selected}>Unavailable metric</option>
      )}
      {groups.map((group) => (
        <optgroup key={group.id} label={group.label}>
          {group.options.map((option) => (
            <option key={metricKey(option.metric)} value={metricKey(option.metric)}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
