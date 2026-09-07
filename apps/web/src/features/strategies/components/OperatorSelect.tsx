"use client";

import {
  conditionOperatorLabel,
  conditionOperatorsFor,
  triggerOperatorLabel,
  triggerOperatorsFor,
  type ConditionOperator,
  type StrategyMetric,
  type TriggerOperator,
} from "@intrinsic/contracts";
import styles from "./StrategyBuilder.module.css";

type OperatorSelectProps = {
  readonly part: "CONDITION" | "TRIGGER";
  readonly metric: StrategyMetric;
  readonly operator: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (operator: string) => void;
  readonly onFocus: (operator: ConditionOperator | TriggerOperator) => void;
  readonly onBlur: () => void;
};

/**
 * The Condition or Trigger control.
 *
 * Which operators appear is the selected Metric's registry entry — `is close to` is offered for
 * Price and moving averages and for nothing else, because that is what the registry says, not
 * because this component knows it.
 */
export function OperatorSelect({
  part,
  metric,
  operator,
  label,
  invalid,
  describedBy,
  onChange,
  onFocus,
  onBlur,
}: OperatorSelectProps) {
  const options: readonly string[] =
    part === "TRIGGER"
      ? triggerOperatorsFor(metric)
      : conditionOperatorsFor(metric);

  const labelFor = (candidate: string): string =>
    part === "TRIGGER"
      ? triggerOperatorLabel(candidate as TriggerOperator)
      : conditionOperatorLabel(candidate as ConditionOperator);

  return (
    <select
      className={styles.select}
      data-testid="operator-select"
      aria-label={label}
      aria-invalid={invalid || undefined}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={operator}
      onFocus={() => onFocus(operator as ConditionOperator | TriggerOperator)}
      onBlur={onBlur}
      onChange={(event) => {
        onChange(event.target.value);
        onFocus(event.target.value as ConditionOperator | TriggerOperator);
      }}
    >
      {options.includes(operator) ? null : (
        <option value={operator}>Unavailable</option>
      )}
      {options.map((candidate) => (
        <option key={candidate} value={candidate}>
          {labelFor(candidate)}
        </option>
      ))}
    </select>
  );
}
