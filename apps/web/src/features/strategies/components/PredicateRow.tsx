"use client";

import {
  asAlternativeDataMetric,
  describeMetricConfiguration,
  strategyMetricLabel,
  type StrategyCondition,
  type StrategyIssuePath,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricCategoryId,
  type StrategyTrigger,
  type StrategyValue,
} from "@intrinsic/contracts";
import { useState } from "react";
import { AlternativeDataConfigDialog } from "../../alternative-data/components/AlternativeDataConfigDialog";
import type { PredicateRef } from "../utils/strategy-draft";
import type { StrategyIssueLookup } from "../utils/strategy-issues";
import { messageAt } from "../utils/strategy-issues";
import styles from "./StrategyBuilder.module.css";
import { CategorySelect } from "./CategorySelect";
import { MetricSelect } from "./MetricSelect";
import { OperatorSelect } from "./OperatorSelect";
import { ValueControl } from "./ValueControl";
import { ExplanationPanel } from "./ExplanationPanel";
import panel from "./ExplanationPanel.module.css";
import { subjectOfRow, type HelpField, type HelpFocus } from "./help-focus";
import { useScopeNames } from "./scope-names";

type PredicateRowProps = {
  readonly levelKind: StrategyLevelKind;
  readonly ref_: PredicateRef;
  readonly row: StrategyCondition | StrategyTrigger;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly connector: "AND" | null;
  readonly onSetCategory: (category: StrategyMetricCategoryId) => void;
  readonly onSetMetric: (metric: StrategyMetric) => void;
  readonly onSetOperator: (operator: string) => void;
  readonly onSetValue: (value: StrategyValue) => void;
  readonly onRemove: () => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
  readonly removeLabel: string;
  readonly focus: HelpFocus;
};

/**
 * One rule, read as a short sentence: the Metric — chosen as a Category, then a Metric within it —
 * then the Condition or Trigger, then the Value.
 *
 * The same component serves both, because the product grammar is the same fields; only the
 * operator vocabulary differs, and that comes from the registry. A configurable metric's
 * configuration is edited in its own dialog and summarized on a line of its own beneath the fields —
 * `180D · CEO, CFO` — by the same function the Strategy logic and the explanation panel use.
 */
export function PredicateRow({
  levelKind,
  ref_,
  row,
  issues,
  isRevealed,
  touch,
  connector,
  onSetCategory,
  onSetMetric,
  onSetOperator,
  onSetValue,
  onRemove,
  onFocusHelp,
  removeLabel,
  focus,
}: PredicateRowProps) {
  // From context, not a prop: four intermediate components carrying names they never read is how a
  // builder accumulates noise (`ScopeNamesContext`).
  const scopeNames = useScopeNames();
  // A metric whose configuration belongs to the signal rather than to the row. The dialog edits a
  // draft and commits through the same `setMetric` a change of metric uses, so the operator and the
  // value are reconciled by the one canonical rule.
  const [configuring, setConfiguring] = useState(false);
  const alternative = asAlternativeDataMetric(row.metric);
  const configuration = describeMetricConfiguration(row.metric, scopeNames);
  const pathFor = (
    field: "METRIC" | "OPERATOR" | "VALUE",
  ): StrategyIssuePath => ({
    ...ref_,
    field,
  });
  const rowPath: StrategyIssuePath = { ...ref_ };
  const focusField = (field: HelpField) =>
    onFocusHelp({ kind: "FIELD", rowId: row.id, field });

  const fieldMessage = (field: "METRIC" | "OPERATOR" | "VALUE") =>
    messageAt(issues, pathFor(field), isRevealed(pathFor(field)));
  // A row-level issue — a Condition repeating another — is about the whole row, and no control
  // touches the row path itself, so touching any of the row's fields reveals it.
  const rowRevealed =
    isRevealed(rowPath) ||
    (["METRIC", "OPERATOR", "VALUE"] as const).some((field) =>
      isRevealed(pathFor(field)),
    );
  const rowMessage = messageAt(issues, rowPath, rowRevealed);

  // Unique per row: an Exit Rule index is part of the address, or two rules' rows share an id.
  const domId = `${ref_.levelKind}-${ref_.levelIndex ?? "x"}-${ref_.ruleIndex ?? "x"}-${ref_.part}-${ref_.conditionIndex ?? "x"}`;
  const errorId = `${domId}-error`;
  const configurationId = `${domId}-configuration`;
  const message =
    fieldMessage("METRIC") ??
    fieldMessage("OPERATOR") ??
    fieldMessage("VALUE") ??
    rowMessage;
  const describedBy = message ? errorId : undefined;
  // The metric's configuration is part of what the Metric control currently means, so assistive
  // technology reads it with the control rather than only as a line below it.
  const metricDescribedBy =
    [configuration === null ? null : configurationId, describedBy]
      .filter((id): id is string => id !== null && id !== undefined)
      .join(" ") || undefined;
  const inlineSubject =
    focus?.kind === "FIELD" && focus.rowId === row.id
      ? subjectOfRow(row, focus.field)
      : null;

  return (
    <li className={styles.predicateRow} data-testid="predicate-row">
      <span
        className={styles.connector}
        aria-hidden={connector ? undefined : "true"}
      >
        {connector ?? ""}
      </span>
      <div className={styles.predicateFields}>
        <CategorySelect
          levelKind={levelKind}
          part={ref_.part}
          metric={row.metric}
          label="Category"
          invalid={fieldMessage("METRIC") !== null}
          {...(describedBy ? { describedBy } : {})}
          onChange={(category) => {
            touch(pathFor("METRIC"));
            onSetCategory(category);
          }}
          onFocus={() => focusField("METRIC")}
          onBlur={() => touch(pathFor("METRIC"))}
        />
        <MetricSelect
          levelKind={levelKind}
          part={ref_.part}
          metric={row.metric}
          label="Metric"
          invalid={fieldMessage("METRIC") !== null}
          {...(metricDescribedBy ? { describedBy: metricDescribedBy } : {})}
          onChange={(metric) => {
            touch(pathFor("METRIC"));
            onSetMetric(metric);
          }}
          onFocus={() => focusField("METRIC")}
          onBlur={() => touch(pathFor("METRIC"))}
        />
        <OperatorSelect
          part={ref_.part}
          metric={row.metric}
          operator={row.operator}
          label={ref_.part === "TRIGGER" ? "Trigger" : "Condition"}
          invalid={fieldMessage("OPERATOR") !== null}
          {...(describedBy ? { describedBy } : {})}
          onChange={(operator) => {
            touch(pathFor("OPERATOR"));
            onSetOperator(operator);
          }}
          onFocus={() => focusField("OPERATOR")}
          onBlur={() => touch(pathFor("OPERATOR"))}
        />
        <ValueControl
          metric={row.metric}
          value={row.value}
          label="Value"
          invalid={fieldMessage("VALUE") !== null}
          {...(describedBy ? { describedBy } : {})}
          onChange={(value) => onSetValue(value)}
          // The third field explains itself like the first two: focusing or choosing a series
          // describes that series, on the desktop rail and in this row alike.
          onFocus={() => focusField("VALUE")}
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
      {alternative ? (
        <div className={styles.operandConfig}>
          <button
            type="button"
            className={styles.operandConfigButton}
            data-testid="operand-config-button"
            aria-label={`Configure ${strategyMetricLabel(row.metric)}`}
            // Deliberately no help focus here. On a phone the explanation sits under the focused row,
            // so moving it on this button's focus would shift the row between press and release and
            // the browser would deliver the click to an ancestor instead of this button.
            onClick={() => setConfiguring(true)}
          >
            Configure
          </button>
          {configuration ? (
            <span
              className={styles.operandConfiguration}
              id={configurationId}
              data-testid="operand-configuration-summary"
              title={configuration}
            >
              {configuration}
            </span>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p className={styles.rowError} id={errorId} role="alert">
          {message}
        </p>
      ) : null}

      {configuring && alternative ? (
        <AlternativeDataConfigDialog
          metric={alternative}
          onClose={() => setConfiguring(false)}
          onApply={(next) => {
            touch(pathFor("METRIC"));
            onSetMetric(next);
            setConfiguring(false);
          }}
        />
      ) : null}
      {inlineSubject ? (
        <div className={panel.inlineHelp} data-testid="inline-help">
          <ExplanationPanel
            subject={inlineSubject}
            testId="inline-explanation-panel"
            compact
          />
        </div>
      ) : null}
    </li>
  );
}
