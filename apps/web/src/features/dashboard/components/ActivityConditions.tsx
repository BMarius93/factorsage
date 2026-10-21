import type {
  MonitorWhyPredicateResponse,
  MonitorWhyResponse,
} from "@intrinsic/contracts";
import { predicateComparison } from "../utils/activity";
import styles from "./ActivityConditions.module.css";

const MARKS: Record<
  NonNullable<MonitorWhyPredicateResponse["result"]>,
  string
> = {
  TRUE: "✓",
  FALSE: "✕",
  NOT_EVALUABLE: "–",
};

const RESULT_TEXT: Record<
  NonNullable<MonitorWhyPredicateResponse["result"]>,
  string
> = {
  TRUE: "held",
  FALSE: "did not hold",
  NOT_EVALUABLE: "could not be decided",
};

/**
 * Every condition behind one activity event, one per line, always visible
 * (`docs/decisions/monitor-eod-v2.md` §6.3, Dashboard V2).
 *
 * The lines are the Why the API rendered from the Strategy version that decided the event, in the
 * Strategy's own order: each predicate in the canonical description language, its result as a mark
 * — ✓ held, ✕ did not hold, – could not be decided, which is never drawn as a failure — and the
 * operands the decision compared (`predicateComparison`). Nothing is evaluated or recomputed here.
 *
 * The logic is shown as the product defines it, never flattened: a signal's Conditions and its
 * Trigger are ANDed, so each line after the first carries `and` in a reserved gutter; a FINAL EXIT
 * reached by several Exit Rules lists each rule under its own label, the rules joined by `or`. A
 * Why recorded without values shows its rules alone and says so.
 */
export function ActivityConditions({
  why,
  testId = "dashboard-conditions",
}: {
  readonly why: MonitorWhyResponse | undefined;
  readonly testId?: string;
}) {
  if (!why || why.rules.length === 0) {
    return (
      <p className={styles.unavailable} data-testid={`${testId}-unavailable`}>
        Conditions are not available for this event.
      </p>
    );
  }
  const labelled = why.rules.some((rule) => rule.exitRule !== undefined);

  return (
    <div
      className={styles.conditions}
      data-testid={testId}
      data-basis={why.basis}
    >
      <ol className={styles.lines}>
        {why.rules.flatMap((rule, ruleIndex) => {
          const lines = [];
          if (labelled) {
            lines.push(
              <li
                key={`rule-${ruleIndex}`}
                className={styles.ruleLine}
                data-testid="dashboard-condition-rule"
              >
                <span className={styles.connector}>
                  {ruleIndex > 0 ? "or" : null}
                </span>
                <span className={styles.ruleLabel}>
                  {rule.exitRule === undefined
                    ? "Exit rule"
                    : `Exit rule ${rule.exitRule}`}
                </span>
              </li>,
            );
          } else if (ruleIndex > 0) {
            // Several rules without labels never happen today; if they did, they would still be
            // alternatives, and must not read as one AND group.
            lines.push(
              <li key={`rule-${ruleIndex}`} className={styles.ruleLine}>
                <span className={styles.connector}>or</span>
              </li>,
            );
          }
          rule.predicates.forEach((predicate, index) => {
            const comparison = predicateComparison(predicate);
            lines.push(
              <li
                key={`${ruleIndex}-${index}`}
                className={styles.line}
                data-result={predicate.result ?? "unrecorded"}
                data-role={predicate.role}
                data-testid="dashboard-condition"
              >
                <span className={styles.connector}>
                  {index > 0 ? "and" : null}
                </span>
                <span className={styles.mark} aria-hidden="true">
                  {predicate.result ? MARKS[predicate.result] : null}
                </span>
                <span className={styles.expression}>
                  {predicate.role === "TRIGGER" ? (
                    <span className={styles.role}>Trigger </span>
                  ) : null}
                  <span data-testid="dashboard-condition-expression">
                    {predicate.description}
                  </span>
                  {predicate.result ? (
                    <span className={styles.srOnly}>
                      {" "}
                      — {RESULT_TEXT[predicate.result]}
                    </span>
                  ) : null}
                </span>
                {comparison ? (
                  <span
                    className={styles.values}
                    data-testid="dashboard-condition-values"
                  >
                    {comparison}
                  </span>
                ) : null}
              </li>,
            );
          });
          return lines;
        })}
      </ol>
      {why.basis === "RULE_ONLY" ? (
        <p className={styles.note} data-testid={`${testId}-unrecorded`}>
          Values were not recorded for this signal.
        </p>
      ) : null}
    </div>
  );
}
