"use client";

import {
  SELECTABLE_SERIES_GROUP_LABELS,
  findSelectableSeries,
  strategyValueLabel,
  valueSpecFor,
  type SelectableSeriesGroupId,
  type SelectableSeriesId,
  type StrategyMetric,
  type StrategyValue,
} from "@intrinsic/contracts";
import { OperandPicker, type OperandPickerCategory } from "./OperandPicker";
import styles from "./StrategyBuilder.module.css";

type ValueControlProps = {
  readonly metric: StrategyMetric;
  readonly value: StrategyValue;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (value: StrategyValue) => void;
  /**
   * The Value came into focus, or a new one was chosen.
   *
   * Series-valued only: the explanation surface reads the selected series from the draft and
   * describes it exactly as it describes the same series chosen as a Metric. A numeric threshold
   * never reports focus, because there is no canonical help for a number the user typed.
   */
  readonly onFocus?: () => void;
  readonly onBlur: () => void;
};

/**
 * The permitted series, partitioned by the catalog's own groups — `Moving averages — Daily`,
 * `Intrinsic Value — Models` — in the catalog's order. The grouping, its labels and its order are the
 * catalog's; nothing here lists a series.
 */
function seriesCategories(
  seriesIds: readonly SelectableSeriesId[],
): readonly OperandPickerCategory[] {
  const groups: {
    id: SelectableSeriesGroupId;
    options: { key: string; label: string }[];
  }[] = [];
  for (const seriesId of seriesIds) {
    const group = findSelectableSeries(seriesId)?.group;
    if (!group) {
      continue;
    }
    const option = {
      key: seriesId,
      label: strategyValueLabel({ kind: "SERIES", seriesId }),
    };
    const existing = groups.find((candidate) => candidate.id === group);
    if (existing) {
      existing.options.push(option);
    } else {
      groups.push({ id: group, options: [option] });
    }
  }
  return groups.map((group) => ({
    id: group.id,
    label: SELECTABLE_SERIES_GROUP_LABELS[group.id],
    options: group.options,
  }));
}

/**
 * The Value control, shaped by the Metric's own value spec.
 *
 * A series-valued Metric is compared with another series through the same picker the Metric is
 * chosen with — the series grouped as the catalog groups them — over exactly the series the registry
 * permits: for a moving average that is `comparableMovingAverages`, so a self-comparison or a
 * daily/weekly pair can never be picked. A numeric or percentage Metric gets an input carrying that
 * metric's own bounds; the bounds are hints on the control, and the canonical validator is what
 * enforces them.
 */
export function ValueControl({
  metric,
  value,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
}: ValueControlProps) {
  const spec = valueSpecFor(metric);

  if (spec.kind === "SERIES") {
    const selected = value.kind === "SERIES" ? value.seriesId : "";
    const group =
      selected === "" ? undefined : findSelectableSeries(selected)?.group;
    return (
      <OperandPicker
        label={label}
        testId="value-control"
        categories={seriesCategories(spec.seriesIds)}
        selectedKey={selected}
        {...(group ? { selectedCategoryId: group } : {})}
        // A series the metric can no longer be compared with stays named rather than silently
        // replaced; validation is what reports it.
        display={selected === "" ? "Choose" : strategyValueLabel(value)}
        placeholder={selected === ""}
        align="end"
        invalid={invalid}
        {...(describedBy ? { describedBy } : {})}
        onFocus={() => {
          if (value.kind === "SERIES") {
            onFocus?.();
          }
        }}
        onBlur={onBlur}
        onSelect={(seriesId) => {
          onChange({
            kind: "SERIES",
            seriesId: seriesId as SelectableSeriesId,
          });
          onFocus?.();
        }}
      />
    );
  }

  const numeric = value.kind === "SERIES" ? "" : String(value.value);
  // The unit is the spec's, so the control cannot print a suffix the validator does not enforce:
  // a percentage reads `25%`, a multiple reads `2x`, a bare threshold reads as itself.
  const unitSuffix =
    spec.kind === "PERCENT" ? "%" : spec.kind === "MULTIPLE" ? "x" : null;

  return (
    <div className={styles.numberField}>
      <input
        className={styles.numberInput}
        data-testid="value-control"
        type="number"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid || undefined}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        {...(spec.min === undefined ? {} : { min: spec.min })}
        {...(spec.max === undefined ? {} : { max: spec.max })}
        {...(spec.kind === "NUMBER" || spec.kind === "MULTIPLE"
          ? { step: spec.step }
          : { step: "any" })}
        value={numeric}
        onBlur={onBlur}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange({
            kind: spec.kind,
            // An empty or partial input is NaN; the validator reports it rather than the control
            // silently substituting a number the user did not type.
            value: event.target.value === "" ? Number.NaN : next,
          });
        }}
      />
      {unitSuffix ? (
        <span className={styles.numberSuffix} aria-hidden="true">
          {unitSuffix}
        </span>
      ) : null}
    </div>
  );
}
