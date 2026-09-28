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
import { Select } from "../../../components/ui/Select";

type OperatorSelectProps = {
  readonly part: "CONDITION" | "TRIGGER";
  readonly metric: StrategyMetric;
  readonly operator: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly onChange: (operator: string) => void;
  /** The control came into focus, or a new operator was chosen; the explanation reads which from the draft. */
  readonly onFocus: () => void;
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
    <Select
      density="compact"
      testId="operator-select"
      aria-label={label}
      title={labelFor(operator)}
      invalid={invalid}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      value={operator}
      onFocus={onFocus}
      onBlur={onBlur}
      onValueChange={(value) => {
        onChange(value);
        onFocus();
      }}
      options={options.map((candidate) => ({
        value: candidate,
        label: labelFor(candidate),
      }))}
    />
  );
}
