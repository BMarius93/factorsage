"use client";

import type {
  ConditionOperator,
  StrategyCondition,
  StrategyIssuePath,
  StrategyLevelKind,
  StrategyMetric,
  StrategyTrigger,
  StrategyValue,
  TriggerOperator,
} from "@intrinsic/contracts";
import type { PredicateRef } from "../utils/strategy-draft";
import type { StrategyIssueLookup } from "../utils/strategy-issues";
import { messageAt } from "../utils/strategy-issues";
import styles from "./StrategyBuilder.module.css";
import { MetricSelect } from "./MetricSelect";
import { OperatorSelect } from "./OperatorSelect";
import { ValueControl } from "./ValueControl";
import type { HelpFocus } from "./help-focus";

type PredicateRowProps = {
  readonly levelKind: StrategyLevelKind;
  readonly ref_: PredicateRef;
  readonly row: StrategyCondition | StrategyTrigger;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly connector: "AND" | null;
  readonly onSetMetric: (metric: StrategyMetric) => void;
  readonly onSetOperator: (operator: string) => void;
  readonly onSetValue: (value: StrategyValue) => void;
  readonly onRemove: () => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
  readonly removeLabel: string;
};

/**
 * One rule, read as a short sentence: Metric, then the Condition or Trigger, then the Value.
 *
 * The same component serves both, because the product grammar is the same three fields; only the
 * operator vocabulary differs, and that comes from the registry.
 */
export function PredicateRow({
  levelKind,
  ref_,
  row,
  issues,
  isRevealed,
  touch,
  connector,
  onSetMetric,
  onSetOperator,
  onSetValue,
  onRemove,
  onFocusHelp,
  removeLabel,
}: PredicateRowProps) {
  const pathFor = (field: "METRIC" | "OPERATOR" | "VALUE"): StrategyIssuePath => ({
    ...ref_,
    field,
  });
  const rowPath: StrategyIssuePath = { ...ref_ };

  const fieldMessage = (field: "METRIC" | "OPERATOR" | "VALUE") =>
    messageAt(issues, pathFor(field), isRevealed(pathFor(field)));
  const rowMessage = messageAt(issues, rowPath, isRevealed(rowPath));

  const errorId = `${ref_.levelKind}-${ref_.levelIndex ?? "x"}-${ref_.part}-${ref_.conditionIndex ?? "x"}-error`;
  const message =
    fieldMessage("METRIC") ??
    fieldMessage("OPERATOR") ??
    fieldMessage("VALUE") ??
    rowMessage;

  return (
    <li className={styles.predicateRow} data-testid="predicate-row">
      <span className={styles.connector} aria-hidden={connector ? undefined : "true"}>
        {connector ?? ""}
      </span>
      <div className={styles.predicateFields}>
        <MetricSelect
          levelKind={levelKind}
          metric={row.metric}
          label="Metric"
          invalid={fieldMessage("METRIC") !== null}
          {...(message ? { describedBy: errorId } : {})}
          onChange={(metric) => {
            touch(pathFor("METRIC"));
            onSetMetric(metric);
          }}
          onFocus={(metric) => onFocusHelp({ kind: "METRIC", metric })}
          onBlur={() => touch(pathFor("METRIC"))}
        />
        <OperatorSelect
          part={ref_.part}
          metric={row.metric}
          operator={row.operator}
          label={ref_.part === "TRIGGER" ? "Trigger" : "Condition"}
          invalid={fieldMessage("OPERATOR") !== null}
          {...(message ? { describedBy: errorId } : {})}
          onChange={(operator) => {
            touch(pathFor("OPERATOR"));
            onSetOperator(operator);
          }}
          onFocus={(operator: ConditionOperator | TriggerOperator) =>
            onFocusHelp({ kind: "OPERATOR", operator })
          }
          onBlur={() => touch(pathFor("OPERATOR"))}
        />
        <ValueControl
          metric={row.metric}
          value={row.value}
          label="Value"
          invalid={fieldMessage("VALUE") !== null}
          {...(message ? { describedBy: errorId } : {})}
          onChange={(value) => onSetValue(value)}
          onBlur={() => touch(pathFor("VALUE"))}
        />
      </div>
      <button
        type="button"
        className={styles.rowRemove}
        aria-label={removeLabel}
        onClick={onRemove}
      >
        ×
      </button>
      {message ? (
        <p className={styles.rowError} id={errorId} role="alert">
          {message}
        </p>
      ) : null}
    </li>
  );
}
