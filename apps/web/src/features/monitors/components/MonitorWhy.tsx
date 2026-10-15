import type {
  MonitorWhyPredicateResponse,
  MonitorWhyResponse,
} from "@intrinsic/contracts";
import { formatEvidenceValue } from "../utils/format";
import styles from "./MonitorWhy.module.css";

const MARKS: Record<
  NonNullable<MonitorWhyPredicateResponse["result"]>,
  string
> = {
  TRUE: "✓",
  FALSE: "✗",
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

/** The values one predicate compared, in reading order; nothing when none were recorded. */
function comparedValues(predicate: MonitorWhyPredicateResponse): string | null {
  if (predicate.result === undefined) {
    return null;
  }
  const value = (number: number | null | undefined) =>
    number === null || number === undefined
      ? "n/a"
      : formatEvidenceValue(number);
  if (predicate.role === "TRIGGER") {
    return `${value(predicate.previousMetric)} → ${value(predicate.metric)} vs ${value(
      predicate.value,
    )}`;
  }
  return `${value(predicate.metric)} vs ${value(predicate.value)}`;
}

/**
 * Why a Signal is active or ended (`docs/decisions/monitor-eod-v2.md` §6): each rule in the
 * Strategy's own words, under the version that decided it, with the values that decision compared.
 *
 * A Signal recorded before values were kept shows its rule alone and says so — nothing is recomputed
 * to fill the gap, and nothing is read from the Strategy as it is today.
 */
export function MonitorWhy({
  why,
  testId = "monitor-why",
}: {
  readonly why: MonitorWhyResponse | undefined;
  readonly testId?: string;
}) {
  if (!why) {
    return <span className={styles.placeholder}>—</span>;
  }
  return (
    <div className={styles.why} data-testid={testId} data-basis={why.basis}>
      {why.rules.map((rule, ruleIndex) => (
        <p key={ruleIndex} className={styles.rule}>
          {rule.exitRule !== undefined ? (
            <span className={styles.ruleLabel}>
              Exit rule {rule.exitRule}:{" "}
            </span>
          ) : null}
          {rule.predicates.map((predicate, index) => {
            const values = comparedValues(predicate);
            return (
              <span
                key={index}
                className={styles.predicate}
                data-result={predicate.result ?? "unrecorded"}
              >
                {index > 0 ? (
                  <span className={styles.joiner}> and </span>
                ) : null}
                {predicate.role === "TRIGGER" ? (
                  <span className={styles.role}>Trigger: </span>
                ) : null}
                {predicate.result ? (
                  <span className={styles.mark} aria-hidden="true">
                    {MARKS[predicate.result]}{" "}
                  </span>
                ) : null}
                {predicate.description}
                {values ? (
                  <span className={styles.values}> ({values})</span>
                ) : null}
                {predicate.result ? (
                  <span className={styles.srOnly}>
                    {" "}
                    — {RESULT_TEXT[predicate.result]}
                  </span>
                ) : null}
              </span>
            );
          })}
        </p>
      ))}
      {why.basis === "RULE_ONLY" ? (
        <p className={styles.note} data-testid={`${testId}-unrecorded`}>
          Values were not recorded for this signal.
        </p>
      ) : null}
    </div>
  );
}
