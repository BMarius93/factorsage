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
 * The logic is shown as the product defines it, never flattened. A signal's Conditions and its
 * Trigger are all ANDed, so they are simply listed, one per line, with no connector between them:
 * a list of requirements reads as "all of these". A FINAL EXIT reached by several Exit Rules lists
 * each rule under its own label, the rules joined by `or` and each rule's lines indented under it,
 * so alternatives can never read as one AND group. Every event the feed receives carries the values
 * that decided it (the API admits no other, `docs/decisions/monitor-eod-v2.md` §12); a Why without
 * them is never drawn as if it had been decided on nothing — it reads as unavailable.
 *
 * The condition is what a reader reads first: the expression is the line's primary text, and the
 * operands it compared follow it smaller and quieter — on the same line where they fit, under the
 * expression where they do not.
 */
export function ActivityConditions({
  why,
  testId = "dashboard-conditions",
}: {
  readonly why: MonitorWhyResponse | undefined;
  readonly testId?: string;
}) {
  if (!why || why.basis !== "EVIDENCE" || why.rules.length === 0) {
    return (
      <p className={styles.unavailable} data-testid={`${testId}-unavailable`}>
        Conditions are not available for this event.
      </p>
    );
  }
  const labelled = why.rules.some((rule) => rule.exitRule !== undefined);
  // Alternatives (Exit Rules, or any Why with more than one rule) keep their `or` structure.
  const alternatives = labelled || why.rules.length > 1;

  return (
    <div
      className={styles.conditions}
      data-testid={testId}
      data-basis={why.basis}
    >
      <ol
        className={styles.lines}
        data-structure={alternatives ? "any-of-rules" : "all"}
      >
        {why.rules.flatMap((rule, ruleIndex) => {
          const lines = [];
          if (alternatives && (labelled || ruleIndex > 0)) {
            lines.push(
              <li
                key={`rule-${ruleIndex}`}
                className={styles.ruleLine}
                data-testid="dashboard-condition-rule"
              >
                {ruleIndex > 0 ? (
                  <span className={styles.connector}>or</span>
                ) : null}
                {labelled ? (
                  <span className={styles.ruleLabel}>
                    {rule.exitRule === undefined
                      ? "Exit rule"
                      : `Exit rule ${rule.exitRule}`}
                  </span>
                ) : null}
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
                <span className={styles.mark} aria-hidden="true">
                  {predicate.result ? MARKS[predicate.result] : null}
                </span>
                <span className={styles.content}>
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
                    <>
                      {" "}
                      <span
                        className={styles.values}
                        data-testid="dashboard-condition-values"
                      >
                        {comparison}
                      </span>
                    </>
                  ) : null}
                </span>
              </li>,
            );
          });
          return lines;
        })}
      </ol>
    </div>
  );
}
