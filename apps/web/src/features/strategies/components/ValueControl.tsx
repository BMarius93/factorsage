"use client";

import {
  strategyValueLabel,
  valueSpecFor,
  type StrategyMetric,
  type StrategyValue,
} from "@intrinsic/contracts";
import { Select } from "../../../components/ui/Select";
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
   * Series-valued only: the explanation surface describes the selected series exactly as it
   * describes the same series chosen as a Metric. A numeric threshold never reports focus,
   * because there is no canonical help for a number the user typed.
   */
  readonly onFocus?: (value: StrategyValue) => void;
  readonly onBlur: () => void;
};

/**
 * The Value control, shaped by the Metric's own value spec.
 *
 * A series-valued Metric gets a select over exactly the series the registry permits — for a moving
 * average that is `comparableMovingAverages`, so a self-comparison or a daily/weekly pair can never
 * be picked. A numeric or percentage Metric gets an input carrying that metric's own bounds; the
 * bounds are hints on the control, and the canonical validator is what enforces them.
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
    return (
      <Select
        density="compact"
        testId="value-control"
        aria-label={label}
        // The row truncates a long series on a phone; the full label stays readable on hover and
        // is what the native picker and the accessible value carry either way.
        {...(selected === "" ? {} : { title: strategyValueLabel(value) })}
        invalid={invalid}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        value={selected}
        onFocus={() => {
          if (value.kind === "SERIES") {
            onFocus?.(value);
          }
        }}
        onBlur={onBlur}
        onValueChange={(seriesId) => {
          const next: StrategyValue = {
            kind: "SERIES",
            seriesId: seriesId as (typeof spec.seriesIds)[number],
          };
          onChange(next);
          onFocus?.(next);
        }}
        {...(selected === ""
          ? { placeholder: "Choose", placeholderDisabled: true }
          : {})}
        unavailableLabel={
          value.kind === "SERIES" ? strategyValueLabel(value) : "Choose"
        }
        options={spec.seriesIds.map((seriesId) => ({
          value: seriesId,
          label: strategyValueLabel({ kind: "SERIES", seriesId }),
        }))}
      />
    );
  }

  const numeric = value.kind === "SERIES" ? "" : String(value.value);
  const isPercent = spec.kind === "PERCENT";

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
        {...(spec.kind === "NUMBER" ? { step: spec.step } : { step: "any" })}
        value={numeric}
        onBlur={onBlur}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange({
            kind: isPercent ? "PERCENT" : "NUMBER",
            // An empty or partial input is NaN; the validator reports it rather than the control
            // silently substituting a number the user did not type.
            value: event.target.value === "" ? Number.NaN : next,
          });
        }}
      />
      {isPercent ? (
        <span className={styles.numberSuffix} aria-hidden="true">
          %
        </span>
      ) : null}
    </div>
  );
}
