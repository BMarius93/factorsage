"use client";

import {
  STRATEGY_LEVEL_HELP,
  STRATEGY_LEVEL_LABELS,
  STRATEGY_METRIC_HELP,
  STRATEGY_OPERATOR_HELP,
  conditionOperatorLabel,
  strategyMetricLabel,
  triggerOperatorLabel,
  type ConditionOperator,
  type StrategyHelpEntry,
  type TriggerOperator,
} from "@intrinsic/contracts";
import type { HelpFocus } from "./help-focus";
import styles from "./ExplanationPanel.module.css";

const CONDITION_OPERATORS: readonly string[] = [
  "IS_ABOVE",
  "IS_BELOW",
  "IS_CLOSE_TO",
];

function titleAndHelp(
  focus: HelpFocus,
): { title: string; help: StrategyHelpEntry } | null {
  if (!focus) {
    return null;
  }
  if (focus.kind === "METRIC") {
    return {
      title: strategyMetricLabel(focus.metric),
      help: STRATEGY_METRIC_HELP[focus.metric.kind],
    };
  }
  if (focus.kind === "OPERATOR") {
    return {
      title: CONDITION_OPERATORS.includes(focus.operator)
        ? conditionOperatorLabel(focus.operator as ConditionOperator)
        : triggerOperatorLabel(focus.operator as TriggerOperator),
      help: STRATEGY_OPERATOR_HELP[focus.operator],
    };
  }
  return {
    title: STRATEGY_LEVEL_LABELS[focus.levelKind],
    help: STRATEGY_LEVEL_HELP[focus.levelKind],
  };
}

/**
 * Explains whatever the builder is focused on, from the canonical help metadata.
 *
 * Every word comes from `@intrinsic/contracts`, keyed by the same identities that supply the
 * options themselves — the feature holds no help strings, for the same reason it holds no labels.
 * Margin of Safety is the metric that most needs this: its row stays three fields with nothing to
 * configure, and the formula, the worked examples and the distinction from upside live here.
 *
 * The panel describes **what a signal means**, never what a backtest does with it. Level
 * repetition, precedence between a partial sell and a final exit, and candidate ordering are open
 * decisions and must not appear here as established behaviour.
 */
export function ExplanationPanel({ focus }: { readonly focus: HelpFocus }) {
  const current = titleAndHelp(focus);

  if (!current) {
    return null;
  }

  const { title, help } = current;

  return (
    <section className={styles.panelCard} data-testid="explanation-panel">
      <h2 className={styles.panelHeading}>{title}</h2>
      <p className={styles.panelSummary}>{help.summary}</p>
      <p className={styles.panelBody}>{help.detail}</p>

      {help.formula ? (
        <p className={styles.panelFormula} data-testid="help-formula">
          {help.formula}
        </p>
      ) : null}

      {help.examples ? (
        <dl className={styles.examples} data-testid="help-examples">
          {help.examples.map((example) => (
            <div key={example.given} className={styles.example}>
              <dt className={styles.exampleGiven}>{example.given}</dt>
              <dd className={styles.exampleResult}>
                <strong>{example.result}</strong> — {example.meaning}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {help.notes ? (
        <ul className={styles.notes} data-testid="help-notes">
          {help.notes.map((note) => (
            <li key={note} className={styles.note}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {help.notEvaluableWhen ? (
        <p className={styles.panelUnavailable} data-testid="help-not-evaluable">
          <span className={styles.panelUnavailableLabel}>Not evaluable when</span>{" "}
          {help.notEvaluableWhen}
        </p>
      ) : null}
    </section>
  );
}
