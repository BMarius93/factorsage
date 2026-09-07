"use client";

import {
  strategyValueLabel,
  valueSpecFor,
  type StrategyMetric,
  type StrategyValue,
} from "@intrinsic/contracts";
import styles from "./StrategyBuilder.module.css";

type ValueControlProps = {
  readonly metric: StrategyMetric;
  readonly value: StrategyValue;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (value: StrategyValue) => void;
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
  onBlur,
}: ValueControlProps) {
  const spec = valueSpecFor(metric);

  if (spec.kind === "SERIES") {
    const selected = value.kind === "SERIES" ? value.seriesId : "";
    return (
      <select
        className={styles.select}
        data-testid="value-control"
        aria-label={label}
        aria-invalid={invalid || undefined}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        value={selected}
        onBlur={onBlur}
        onChange={(event) =>
          onChange({
            kind: "SERIES",
            seriesId: event.target.value as (typeof spec.seriesIds)[number],
          })
        }
      >
        {spec.seriesIds.includes(
          selected as (typeof spec.seriesIds)[number],
        ) ? null : (
          <option value={selected}>
            {value.kind === "SERIES" ? strategyValueLabel(value) : "Choose"}
          </option>
        )}
        {spec.seriesIds.map((seriesId) => (
          <option key={seriesId} value={seriesId}>
            {strategyValueLabel({ kind: "SERIES", seriesId })}
          </option>
        ))}
      </select>
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
